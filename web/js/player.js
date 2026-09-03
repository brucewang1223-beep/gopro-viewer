/**
 * Chapter-aware video player.
 *
 * A recording is a list of chapters (separate MP4 files). The player exposes one
 * global timeline: T = chapter.offsetSec + video.currentTime. Seeking across a
 * chapter boundary swaps the <video> source; when a chapter ends the next one
 * starts automatically. Optional LRV proxy playback uses the same timeline.
 */

import { api } from './api.js';
import { clamp } from './util.js';

export class Player {
  /**
   * @param {HTMLVideoElement} video
   * @param {{ onTime?: (t:number)=>void, onChapter?: (index:number)=>void, onState?: (state:object)=>void, onError?: (msg:string)=>void }} handlers
   */
  constructor(video, handlers = {}) {
    this.video = video;
    this.h = handlers;
    this.recording = null;
    this.chapterIndex = -1;
    this.useProxy = false;
    this.rate = 1;
    this.pendingSeek = null;      // seconds within the chapter to apply on loadedmetadata
    this.resumeAfterLoad = false;
    this.lastT = -1;

    video.addEventListener('loadedmetadata', () => this.#onLoaded());
    video.addEventListener('ended', () => this.#onEnded());
    video.addEventListener('play', () => this.#emitState());
    video.addEventListener('pause', () => { this.#emitState(); this.#emitTime(); });
    video.addEventListener('ratechange', () => this.#emitState());
    video.addEventListener('error', () => this.#onError());
    // Event-driven updates keep the UI consistent even when requestAnimationFrame is
    // throttled (hidden tab) — the rAF loop below provides the smooth per-frame path.
    video.addEventListener('seeked', () => this.#emitTime());
    video.addEventListener('timeupdate', () => this.#emitTime());
    this.#loop();
  }

  #emitTime() {
    if (!this.recording) return;
    const t = this.time;
    if (Math.abs(t - this.lastT) > 0.0005) { this.lastT = t; this.h.onTime?.(t); }
  }

  get chapters() { return this.recording?.chapters ?? []; }
  get chapter() { return this.chapters[this.chapterIndex] ?? null; }
  get duration() { return this.recording?.durationSec ?? 0; }
  get playing() { return !this.video.paused && !this.video.ended; }

  /** Global time (seconds since start of chapter 1). */
  get time() {
    const ch = this.chapter;
    if (!ch) return 0;
    // while a new chapter is loading, video.currentTime still belongs to the previous file
    if (this.pendingSeek != null) return ch.offsetSec + this.pendingSeek;
    return ch.offsetSec + (this.video.currentTime || 0);
  }

  load(recording, { useProxy = false, startAt = 0, autoplay = false } = {}) {
    this.recording = recording;
    this.useProxy = useProxy && recording.hasProxy;
    this.chapterIndex = -1;
    this.lastT = -1;
    this.seek(startAt, { play: autoplay });
    this.h.onState?.(this.state());
  }

  chapterAt(t) {
    const chs = this.chapters;
    if (!chs.length) return -1;
    for (let i = chs.length - 1; i >= 0; i--) if (t >= chs[i].offsetSec) return i;
    return 0;
  }

  /** Seek to global time t. Handles chapter switches. */
  seek(t, { play } = {}) {
    if (!this.recording) return;
    t = clamp(t, 0, Math.max(0, this.duration - 0.05));
    const idx = this.chapterAt(t);
    const ch = this.chapters[idx];
    const local = clamp(t - ch.offsetSec, 0, Math.max(0, ch.durationSec - 0.05));
    const wantPlay = play ?? this.playing;
    if (idx !== this.chapterIndex) {
      this.#loadChapter(idx, local, wantPlay);
    } else {
      if (this.pendingSeek != null) this.pendingSeek = local; // chapter still loading: remember the latest target
      this.video.currentTime = local;
      if (wantPlay && this.video.paused) this.video.play().catch(() => {});
      else if (play === false) this.video.pause();
    }
  }

  #loadChapter(idx, local, wantPlay) {
    const ch = this.chapters[idx];
    this.chapterIndex = idx;
    this.pendingSeek = local;
    this.resumeAfterLoad = wantPlay;
    const fileId = this.useProxy && ch.proxyId ? ch.proxyId : ch.id;
    this.video.src = api.mediaUrl(fileId);
    this.video.playbackRate = this.rate;
    this.video.load();
    this.h.onChapter?.(idx);
    this.#emitState();
  }

  #onLoaded() {
    this.video.playbackRate = this.rate;
    if (this.pendingSeek != null) {
      const s = this.pendingSeek; this.pendingSeek = null;
      if (s > 0) this.video.currentTime = s;
    }
    if (this.resumeAfterLoad) { this.resumeAfterLoad = false; this.video.play().catch(() => {}); }
    this.#emitState();
  }

  #onEnded() {
    if (this.chapterIndex + 1 < this.chapters.length) this.#loadChapter(this.chapterIndex + 1, 0, true);
    else this.#emitState();
  }

  #onError() {
    const err = this.video.error;
    const codes = { 1: 'aborted', 2: 'network error', 3: 'decode error', 4: 'source not supported (codec?)' };
    const msg = err ? `Video error: ${codes[err.code] ?? err.code}${err.message ? ` — ${err.message}` : ''}` : 'Video error';
    this.h.onError?.(msg, { code: err?.code, chapter: this.chapter });
  }

  play() { if (this.recording) this.video.play().catch((e) => this.h.onError?.(`Cannot play: ${e.message}`)); }
  pause() { this.video.pause(); }
  toggle() { if (this.playing) this.pause(); else this.play(); }

  step(dt) { this.seek(this.time + dt); }

  frameStep(dir) {
    const fps = this.chapter?.video?.fps || this.recording?.fps || 30;
    this.pause();
    this.seek(this.time + dir / fps);
  }

  nextChapter() { if (this.chapterIndex + 1 < this.chapters.length) this.seek(this.chapters[this.chapterIndex + 1].offsetSec); }
  prevChapter() {
    const ch = this.chapter; if (!ch) return;
    // within first 2 s of a chapter → previous chapter, otherwise restart current
    if (this.video.currentTime < 2 && this.chapterIndex > 0) this.seek(this.chapters[this.chapterIndex - 1].offsetSec);
    else this.seek(ch.offsetSec);
  }

  setRate(r) { this.rate = r; this.video.playbackRate = r; this.#emitState(); }

  setProxy(on) {
    if (!this.recording) { this.useProxy = on; return; }
    const next = on && this.recording.hasProxy;
    if (next === this.useProxy) return;
    const t = this.time; const playing = this.playing;
    this.useProxy = next;
    this.chapterIndex = -1;
    this.seek(t, { play: playing });
  }

  state() {
    return {
      playing: this.playing, rate: this.rate, chapterIndex: this.chapterIndex, useProxy: this.useProxy,
      time: this.time, duration: this.duration, loaded: !!this.recording,
    };
  }

  #emitState() { this.h.onState?.(this.state()); }

  /** Per-frame time emission for smooth playheads; the player lives as long as the page. */
  #loop() {
    this.#emitTime();
    requestAnimationFrame(() => this.#loop());
  }
}
