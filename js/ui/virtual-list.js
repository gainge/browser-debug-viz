import { h, clear } from '../util/dom.js';

// Fixed-row-height windowed list. Captures routinely contain thousands of
// requests and console lines; rendering only visible rows keeps scrolling smooth.
export class VirtualList {
  constructor({ rowHeight = 26, renderRow, overscan = 10 }) {
    this.rowHeight = rowHeight;
    this.renderRow = renderRow;
    this.overscan = overscan;
    this.items = [];
    this.spacer = h('div', { class: 'vlist-spacer' });
    this.rows = h('div', { class: 'vlist-rows' });
    this.el = h('div', { class: 'vlist', tabindex: '0' }, this.spacer, this.rows);
    this.pending = false;
    this.el.addEventListener('scroll', () => this.schedule());
    new ResizeObserver(() => this.schedule()).observe(this.el);
  }

  setItems(items) {
    this.items = items;
    this.spacer.style.height = `${items.length * this.rowHeight}px`;
    this.render();
  }

  refresh() {
    this.render();
  }

  scrollToIndex(i) {
    const top = i * this.rowHeight;
    const view = this.el.clientHeight;
    if (top < this.el.scrollTop || top + this.rowHeight > this.el.scrollTop + view) {
      this.el.scrollTop = Math.max(0, top - view / 3);
    }
  }

  schedule() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.render();
    });
  }

  render() {
    const { rowHeight, overscan, items } = this;
    const first = Math.max(0, Math.floor(this.el.scrollTop / rowHeight) - overscan);
    const visible = Math.ceil((this.el.clientHeight || 600) / rowHeight) + overscan * 2;
    const last = Math.min(items.length, first + visible);
    clear(this.rows);
    this.rows.style.transform = `translateY(${first * rowHeight}px)`;
    for (let i = first; i < last; i++) {
      const row = this.renderRow(items[i], i);
      row.style.height = `${rowHeight}px`;
      this.rows.append(row);
    }
  }
}
