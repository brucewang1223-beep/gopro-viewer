/**
 * UAE road shields for the K2 street style.
 *
 * The style references icons named `k2-road-shield-{e|d}-{2,3,4}` (E-roads get the
 * blue emirate shield, D-roads the green plate; the digit is the ref length). K2
 * ships no sprite sheet — its own viewer draws the icons on a canvas at load time,
 * and so do we, with the same geometry, so shields render exactly as on their map.
 */

const PREFIX = 'k2-road-shield';
const WIDTH = { 2: 30, 3: 38, 4: 48 };
const HEIGHT = 42;
const SCALE = 2; // drawn at 2× and registered with pixelRatio 2

/** Add (or refresh) the six shield images on a freshly loaded style. */
export function installRoadShields(map) {
  for (const kind of ['e', 'd']) {
    for (const refLength of [2, 3, 4]) {
      const id = `${PREFIX}-${kind}-${refLength}`;
      const image = drawShield(kind, WIDTH[refLength], HEIGHT);
      if (map.hasImage(id)) map.updateImage(id, image);
      else map.addImage(id, image, { pixelRatio: SCALE });
    }
  }
}

function drawShield(kind, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w * SCALE;
  canvas.height = h * SCALE;
  const ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (kind === 'd') drawRoadPlate(ctx, w, h);
  else drawEmirateShield(ctx, w, h);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/** Outline of the blue falcon-wing shield used for E-roads. */
function emirateShieldPath(w, h) {
  const cx = w / 2;
  const left = 3.2;
  const right = w - 3.2;
  const top = 7;
  const shield = new Path2D();
  shield.moveTo(cx - 7.2, top + 1.2);
  shield.bezierCurveTo(cx - 4.8, top - 4.2, cx + 3.4, top - 3.4, cx + 5.7, top + 1.1);
  shield.bezierCurveTo(cx + 6.8, top + 3.5, cx + 10.4, top + 4, right - 2.3, top + 4.3);
  shield.bezierCurveTo(right - 0.2, top + 5.1, right - 1.8, top + 7.2, right - 4.8, top + 7.3);
  shield.lineTo(right - 3.4, h - 7.4);
  shield.quadraticCurveTo(cx + 9.2, h - 1.4, cx, h - 0.9);
  shield.quadraticCurveTo(cx - 9.4, h - 1.5, left + 3.4, h - 7.4);
  shield.lineTo(left + 4.4, top + 13.8);
  shield.lineTo(left + 1.9, top + 13.1);
  shield.lineTo(left + 4.6, top + 10.8);
  shield.lineTo(left + 2, top + 9.8);
  shield.lineTo(left + 5.1, top + 7.9);
  shield.bezierCurveTo(left + 8.2, top + 7.3, cx - 11.4, top + 6.2, cx - 7.2, top + 1.2);
  shield.closePath();
  return shield;
}

function drawEmirateShield(ctx, w, h) {
  const cx = w / 2;
  const top = 7;
  const shield = emirateShieldPath(w, h);

  ctx.shadowColor = 'rgba(18, 42, 66, 0.22)';
  ctx.shadowBlur = 1.5;
  ctx.shadowOffsetY = 0.8;
  ctx.fillStyle = 'rgba(13, 56, 96, 0.22)';
  ctx.fill(shield);
  ctx.shadowColor = 'transparent';

  const body = ctx.createLinearGradient(0, top, 0, h - 1);
  body.addColorStop(0, '#064ec0');
  body.addColorStop(0.48, '#003ea8');
  body.addColorStop(1, '#002f86');
  ctx.fillStyle = body;
  ctx.fill(shield);
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke(shield);

  const beak = new Path2D();
  beak.moveTo(cx + 6.9, top + 3.2);
  beak.lineTo(cx + 11.3, top + 4.1);
  beak.lineTo(cx + 7.5, top + 5.4);
  beak.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.fill(beak);

  ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.beginPath();
  ctx.ellipse(cx - 5.5, top + 10.5, Math.max(5, w * 0.18), 3.2, -0.2, 0, Math.PI * 2);
  ctx.fill();
}

/** Green plate with carriageway dashes used for D-roads. */
function drawRoadPlate(ctx, w, h) {
  const left = 4;
  const right = w - 4;
  const top = 4;
  const bottom = h - 2.5;
  const plate = new Path2D();
  plate.moveTo(left, top);
  plate.lineTo(right, top);
  plate.lineTo(right, bottom);
  plate.lineTo(left, bottom);
  plate.closePath();

  ctx.shadowColor = 'rgba(12, 54, 34, 0.22)';
  ctx.shadowBlur = 1.5;
  ctx.shadowOffsetY = 0.8;
  ctx.fillStyle = 'rgba(0, 82, 48, 0.18)';
  ctx.fill(plate);
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = '#00824b';
  ctx.fill(plate);
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke(plate);

  ctx.fillStyle = '#ffffff';
  const dashes = Math.max(3, Math.floor(w / 9));
  const dashWidth = 3.6;
  const gap = (right - left - dashes * dashWidth) / (dashes + 1);
  for (let i = 0; i < dashes; i++) ctx.fillRect(left + gap + i * (dashWidth + gap), top, dashWidth, 4.8);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
  ctx.fillRect(7, top + 7, right - left - 6, 3);
}
