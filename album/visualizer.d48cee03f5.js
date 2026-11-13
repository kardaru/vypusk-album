// Спектр поверх обложки. Считаем из AnalyserNode, рисуем в canvas,
// заодно отдаём наружу энергию низов — на ней дышит обложка и разгорается свет.
const BAR_COLORS = ['#f0b354', '#e08b3c', '#6d8fa6'];

export class Spectrum {
  constructor(canvas, analyser) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.analyser = analyser;
    this.bins = new Uint8Array(analyser.frequencyBinCount);
    this.bars = 52;
    this.levels = new Float32Array(this.bars);
    this.peaks = new Float32Array(this.bars);
    this.bass = 0;
    this.rms = 0;
    this.raf = 0;
    this.last = 0;
    this.interval = 1000 / 60;

    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    this.idle();

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.stop();
      else if (this.want) this.start();
    });
  }

  resize() {
    const box = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(2, Math.round(box.width * dpr));
    this.canvas.height = Math.max(2, Math.round(box.height * dpr));
    this.idle();
  }

  start() {
    this.want = true;
    if (this.raf) return;
    const loop = (t) => {
      this.raf = requestAnimationFrame(loop);
      if (t - this.last < this.interval) return;
      this.last = t;
      this.frame();
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.want = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  idle() {
    const { ctx, canvas: c, bars } = this;
    ctx.clearRect(0, 0, c.width, c.height);
    const slot = c.width / bars;
    const bw = Math.max(1, slot * 0.46);
    ctx.fillStyle = 'rgba(223, 227, 230, .22)';
    for (let i = 0; i < bars; i++) ctx.fillRect(i * slot + (slot - bw) / 2, c.height - 4, bw, 3);
  }

  frame() {
    const { ctx, canvas: c, analyser, bins, levels, peaks, bars } = this;
    analyser.getByteFrequencyData(bins);

    for (let i = 0; i < bars; i++) {
      const from = Math.floor(Math.pow(i / bars, 1.75) * (bins.length - 1));
      const to = Math.max(from + 1, Math.floor(Math.pow((i + 1) / bars, 1.75) * (bins.length - 1)));
      let sum = 0;
      for (let j = from; j < to; j++) sum += bins[j];
      const v = sum / (to - from) / 255;
      levels[i] += (v - levels[i]) * (v > levels[i] ? 0.55 : 0.12);
      peaks[i] = Math.max(peaks[i] * 0.985, levels[i]);
    }

    const low = (levels[1] + levels[2] + levels[3]) / 3;
    const all = levels.reduce((a, b) => a + b, 0) / bars;
    this.bass += (low - this.bass) * 0.3;
    this.rms += (all - this.rms) * 0.2;

    const w = c.width;
    const h = c.height;
    const base = h - 1;
    const max = h * 0.92;
    ctx.clearRect(0, 0, w, h);

    const slot = w / bars;
    const bw = Math.max(1, slot * 0.46);

    for (let i = 0; i < bars; i++) {
      const x = i * slot + (slot - bw) / 2;
      const bh = Math.max(1.5, levels[i] * max);
      const grad = ctx.createLinearGradient(0, base, 0, base - max);
      grad.addColorStop(0, BAR_COLORS[0]);
      grad.addColorStop(0.65, BAR_COLORS[1]);
      grad.addColorStop(1, BAR_COLORS[2]);
      ctx.fillStyle = grad;
      ctx.globalAlpha = 0.35 + levels[i] * 0.65;
      ctx.fillRect(x, base - bh, bw, bh);

      // точка удержания пика
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = '#e9e4d9';
      ctx.fillRect(x, base - Math.max(2, peaks[i] * max) - 1, bw, 1);
    }
    ctx.globalAlpha = 1;
  }
}
