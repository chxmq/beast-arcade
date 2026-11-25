import { describe, expect, it } from 'vitest';
import { KEY, PAYOUT_KEY, Wallet, type StorageLike } from './wallet.ts';

class MemStorage implements StorageLike {
  data = new Map<string, string>();
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
}

describe('tickets wallet', () => {
  it('starts at zero and adds whole tickets', () => {
    const w = new Wallet(new MemStorage());
    expect(w.balance()).toBe(0);
    w.add(12.9, 'micro');
    expect(w.balance()).toBe(12);
  });

  it('ignores zero, negative and non-numeric payouts', () => {
    const w = new Wallet(new MemStorage());
    w.add(0);
    w.add(-50);
    w.add(Number.NaN);
    w.add(Number.POSITIVE_INFINITY);
    expect(w.balance()).toBe(0);
  });

  it('spend succeeds when the balance covers it and changes nothing when it does not', () => {
    const w = new Wallet(new MemStorage());
    w.add(250);
    expect(w.spend(300)).toBe(false);
    expect(w.balance()).toBe(250);
    expect(w.spend(100)).toBe(true);
    expect(w.balance()).toBe(150);
    expect(w.spend(150)).toBe(true);
    expect(w.balance()).toBe(0);
    expect(w.spend(1)).toBe(false);
  });

  it('tells subscribers the balance, the delta and the reason, until they unsubscribe', () => {
    const w = new Wallet(new MemStorage());
    const seen: [number, number, string][] = [];
    const off = w.subscribe((b, d, r) => seen.push([b, d, r]));
    w.add(40, 'catch');
    w.spend(15, 'capsule');
    expect(w.spend(1000)).toBe(false);
    off();
    w.add(5);
    expect(seen).toEqual([[40, 40, 'catch'], [25, -15, 'capsule']]);
  });

  it('persists across instances and survives corrupt storage', () => {
    const st = new MemStorage();
    const a = new Wallet(st);
    a.add(321);
    a.spend(21);
    expect(st.getItem(KEY)).toBe('300');
    expect(new Wallet(st).balance()).toBe(300);
    st.setItem(KEY, 'banana');
    st.setItem(PAYOUT_KEY, '{not json');
    const c = new Wallet(st);
    expect(c.balance()).toBe(0);
    expect(c.payouts('micro')).toEqual({ runs: 0, total: 0, best: 0, last: 0 });
    st.setItem(KEY, '-40');
    expect(new Wallet(st).balance()).toBe(0);
  });

  it('works without storage at all', () => {
    const w = new Wallet(null);
    w.add(10);
    expect(w.balance()).toBe(10);
  });

  it('credits payouts to the cabinet on screen, not refunds made outside a game', () => {
    const st = new MemStorage();
    const w = new Wallet(st);
    w.setSource('micro');
    w.add(30);
    w.add(10);
    w.setSource(null);
    w.add(25, 'refund');
    w.setSource('catch');
    w.add(7);
    expect(w.payouts('micro')).toEqual({ runs: 2, total: 40, best: 30, last: 10 });
    expect(w.payouts('catch')).toEqual({ runs: 1, total: 7, best: 7, last: 7 });
    expect(w.payouts('eyes')).toEqual({ runs: 0, total: 0, best: 0, last: 0 });
    expect(w.balance()).toBe(72);
    expect(new Wallet(st).payouts('micro').total).toBe(40);
  });

  it('payouts() returns a copy', () => {
    const w = new Wallet(new MemStorage());
    w.setSource('eyes');
    w.add(5);
    const p = w.payouts('eyes');
    p.total = 999;
    expect(w.payouts('eyes').total).toBe(5);
  });
});
