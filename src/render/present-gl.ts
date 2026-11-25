// WebGL2 presenter: the field is uploaded as an R8 texture every frame and read with texelFetch
// at an integer scale (letterboxed). No filtering, no antialiasing, nothing temporal.

import { Layout, resolveColors, watchResize, type PresentOpts, type Presenter } from './present-common.ts';

const VS = `#version 300 es
void main() {
  // full-screen triangle from gl_VertexID
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uTex;
uniform ivec2 uField;   // field w, h
uniform int uScale;     // device px per field px
uniform ivec2 uOff;     // device px offset of the field, from the top-left
uniform int uCanvasH;   // device px
uniform vec3 uInk;      // colour of 1-pixels
uniform vec3 uPaper;    // colour of 0-pixels
uniform float uScan;    // scanline darkening (static)
uniform float uVig;     // vignette strength (static)
out vec4 outColor;
void main() {
  ivec2 d = ivec2(int(gl_FragCoord.x), uCanvasH - 1 - int(gl_FragCoord.y));
  ivec2 q = d - uOff;
  ivec2 f = q / uScale;
  if (q.x < 0 || q.y < 0 || f.x >= uField.x || f.y >= uField.y) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  float v = texelFetch(uTex, f, 0).r * 255.0;   // stored as 0|1
  vec3 c = v > 0.5 ? uInk : uPaper;
  int sub = q.y - f.y * uScale;
  if (sub == uScale - 1) c *= 1.0 - uScan;
  vec2 uv = (vec2(q) + 0.5) / vec2(uField * uScale) - 0.5;
  c *= 1.0 - uVig * dot(uv, uv) * 2.0;
  outColor = vec4(c, 1.0);
}`;

function compile(gl: WebGL2RenderingContext): WebGLProgram {
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
    return s;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(prog));
  return prog;
}

const CTX_ATTRS: WebGLContextAttributes = {
  alpha: false,
  antialias: false,
  depth: false,
  stencil: false,
  premultipliedAlpha: false,
  preserveDrawingBuffer: false,
  powerPreference: 'high-performance',
};

/** True if WebGL2 works and our shader compiles (probed on a throwaway canvas). */
export function webgl2Available(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2', CTX_ATTRS);
    if (!gl) return false;
    compile(gl);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/** Returns null if a WebGL2 context cannot be created on this canvas. */
export function createGLPresenter(canvas: HTMLCanvasElement): Presenter | null {
  const gl = canvas.getContext('webgl2', CTX_ATTRS);
  if (!gl) return null;
  const layout = new Layout(canvas);
  let prog: WebGLProgram;
  let tex: WebGLTexture;
  let vao: WebGLVertexArrayObject;
  let U: Record<string, WebGLUniformLocation | null> = {};
  let texW = 0;
  let texH = 0;
  let lost = false;

  const init = () => {
    prog = compile(gl);
    vao = gl.createVertexArray()!;
    tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    U = {};
    for (const n of ['uTex', 'uField', 'uScale', 'uOff', 'uCanvasH', 'uInk', 'uPaper', 'uScan', 'uVig'])
      U[n] = gl.getUniformLocation(prog, n);
    texW = texH = 0;
  };
  init();

  const onLost = (e: Event) => {
    e.preventDefault();
    lost = true;
  };
  const onRestored = () => {
    lost = false;
    init();
  };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  layout.measure();
  const unwatch = watchResize(canvas, () => layout.measure());

  return {
    kind: 'webgl2',
    get scale() {
      return layout.devScale;
    },
    get offsetX() {
      return layout.devOffX;
    },
    get offsetY() {
      return layout.devOffY;
    },
    get dpr() {
      return layout.dpr;
    },
    resize() {
      layout.measure();
    },
    toField(cx: number, cy: number) {
      return layout.toField(cx, cy);
    },
    draw(field: Uint8Array, w: number, h: number, opts: PresentOpts) {
      if (lost) return;
      layout.setField(w, h, opts.maxScale ?? 0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      if (texW !== w || texH !== h) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, field.subarray(0, w * h));
        texW = w;
        texH = h;
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.UNSIGNED_BYTE, field.subarray(0, w * h));
      }
      const { ink, paper } = resolveColors(opts);
      const fx = opts.fx ?? true;
      gl.viewport(0, 0, layout.devW, layout.devH);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(U.uTex, 0);
      gl.uniform2i(U.uField, w, h);
      gl.uniform1i(U.uScale, layout.devScale);
      gl.uniform2i(U.uOff, layout.devOffX, layout.devOffY);
      gl.uniform1i(U.uCanvasH, layout.devH);
      gl.uniform3f(U.uInk, ink[0], ink[1], ink[2]);
      gl.uniform3f(U.uPaper, paper[0], paper[1], paper[2]);
      gl.uniform1f(U.uScan, fx && layout.devScale >= 4 ? 0.08 : 0);
      gl.uniform1f(U.uVig, fx ? 0.1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    destroy() {
      unwatch();
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      gl.deleteTexture(tex);
      gl.deleteProgram(prog);
      gl.deleteVertexArray(vao);
    },
  };
}
