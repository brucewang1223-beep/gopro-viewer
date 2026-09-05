/**
 * MapLibre controls added on top of the K2 basemap:
 *   ButtonsControl   small icon buttons (fit the route, centre on the position)
 *   BasemapControl   the Map / Satellite switcher, matching the card picker on
 *                    map.lumobility.com; the Satellite card carries a Labels chip.
 */

const SVG_OPEN = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';

export const ICONS = {
  fit: `${SVG_OPEN}<path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4"/><path d="M8 12h8" opacity=".5"/></svg>`,
  locate: `${SVG_OPEN}<circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>`,
};

/** Thumbnails drawn in the K2 palette so the cards match what they switch to. */
const THUMBS = {
  streets: '<svg viewBox="0 0 64 44" preserveAspectRatio="none">'
    + '<rect width="64" height="44" fill="#eee8e3"/>'
    + '<path d="M0 30h26l10 14H0z" fill="#bdf0b8"/><path d="M46 0h18v16l-18 6z" fill="#8bd7f6"/>'
    + '<path d="M-2 16h68" stroke="#ef9b45" stroke-width="7"/><path d="M-2 16h68" stroke="#ffd659" stroke-width="4.5"/>'
    + '<path d="M22 -2v48M-2 33h68" stroke="#d7d1c8" stroke-width="5"/><path d="M22 -2v48M-2 33h68" stroke="#fff" stroke-width="3"/></svg>',
  satellite: '<svg viewBox="0 0 64 44" preserveAspectRatio="none">'
    + '<rect width="64" height="44" fill="#0d2f38"/>'
    + '<path d="M0 0h30l8 20-14 24H0z" fill="#2f4a2c"/><path d="M30 0h34v18l-22 8z" fill="#3d3a2a"/>'
    + '<path d="M40 44l6-20 18-6v26z" fill="#4a4230"/><circle cx="18" cy="12" r="7" fill="#37502f"/>'
    + '<path d="M-2 24h68" stroke="rgba(228,236,240,.55)" stroke-width="2"/></svg>',
};

/** A vertical group of icon buttons. */
export class ButtonsControl {
  /** @param {Array<[string, string, () => void]>} buttons  [icon html, title, handler] */
  constructor(buttons) {
    this.buttons = buttons;
  }

  onAdd() {
    this.container = document.createElement('div');
    this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    for (const [icon, title, handler] of this.buttons) {
      const button = document.createElement('button');
      button.type = 'button';
      button.title = title;
      button.setAttribute('aria-label', title);
      button.innerHTML = icon;
      button.addEventListener('click', handler);
      this.container.append(button);
    }
    return this.container;
  }

  onRemove() { this.container.remove(); }
}

export class BasemapControl {
  /**
   * @param {{ basemaps: Record<string, {label: string}>, active: string, labels: boolean,
   *   onSelect: (key: string) => void, onLabels: (on: boolean) => void }} opts
   */
  constructor({ basemaps, active, labels, onSelect, onLabels }) {
    this.basemaps = basemaps;
    this.active = active;
    this.labels = labels;
    this.onSelect = onSelect;
    this.onLabels = onLabels;
  }

  onAdd() {
    this.container = document.createElement('div');
    this.container.className = 'maplibregl-ctrl basemap-ctrl';
    this.container.append(this.#toggle(), this.#panel());
    this.#sync();
    this.closeOnOutside = (e) => { if (!this.container.contains(e.target)) this.#open(false); };
    document.addEventListener('pointerdown', this.closeOnOutside);
    return this.container;
  }

  onRemove() {
    document.removeEventListener('pointerdown', this.closeOnOutside);
    this.container.remove();
  }

  #toggle() {
    this.toggleButton = document.createElement('button');
    this.toggleButton.type = 'button';
    this.toggleButton.className = 'basemap-toggle';
    this.toggleButton.title = 'Basemap (B)';
    this.toggleButton.addEventListener('click', () => this.#open(this.panel.hidden));
    return this.toggleButton;
  }

  #panel() {
    this.panel = document.createElement('div');
    this.panel.className = 'basemap-cards';
    this.panel.hidden = true;
    this.cards = new Map();
    for (const [key, { label }] of Object.entries(this.basemaps)) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'basemap-card';
      card.innerHTML = `<span class="basemap-thumb">${THUMBS[key] ?? ''}</span><span class="basemap-name">${label}</span>`;
      card.addEventListener('click', () => { this.#open(false); this.onSelect(key); });
      if (key === 'satellite') card.append(this.#labelsChip());
      this.cards.set(key, card);
      this.panel.append(card);
    }
    return this.panel;
  }

  #labelsChip() {
    this.chip = document.createElement('span');
    this.chip.className = 'basemap-chip';
    this.chip.textContent = 'Labels';
    this.chip.setAttribute('role', 'switch');
    this.chip.title = 'Show place and road labels over the imagery';
    this.chip.addEventListener('click', (e) => {
      e.stopPropagation();
      this.labels = !this.labels;
      this.#sync();
      this.onLabels(this.labels);
    });
    return this.chip;
  }

  #open(open) {
    this.panel.hidden = !open;
    this.container.classList.toggle('is-open', open);
    this.toggleButton.setAttribute('aria-expanded', String(open));
  }

  /** Reflect the current basemap / labels state in the cards. */
  #sync() {
    this.toggleButton.innerHTML = `<span class="basemap-thumb">${THUMBS[this.active] ?? ''}</span>`
      + `<span class="basemap-name">${this.basemaps[this.active]?.label ?? ''}</span>`;
    for (const [key, card] of this.cards ?? []) { card.classList.toggle('is-active', key === this.active); card.setAttribute('aria-pressed', String(key === this.active)); }
    this.chip?.classList.toggle('is-on', this.labels);
    this.chip?.setAttribute('aria-checked', String(this.labels));
  }

  setState({ active = this.active, labels = this.labels } = {}) {
    this.active = active;
    this.labels = labels;
    this.#sync();
  }
}
