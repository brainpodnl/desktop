import type { ReactElement } from 'react';

/**
 * The dot-globe backdrop from the marketing site (`components/Backdrop.tsx`):
 * an orthographic projection with the Dutch region at the centre of the visible
 * hemisphere, under the site's full stack of bloom, vignette, grain and fade.
 *
 * Pocket's port dropped five of those layers because React Native cannot draw
 * them. A Tauri window is a browser, so they are all back, expressed the way the
 * site expresses them: CSS masks and gradients rather than nested SVG filters.
 *
 * Both geometry layers collapse into a single path each, so the whole globe is
 * two nodes rather than thousands.
 */

const ORIGIN = { lat: 52.1, lon: 5.6 };
const VIEW = { width: 1200, height: 1200 };
const CENTER = { x: 600, y: 520 };
const GLOBE_RADIUS = 1200;
const DOT_STEP = 1.2;
const LINE_STEP = 12;
const LINE_SAMPLE = 3;
const MARGIN = 40;

const RAD = Math.PI / 180;
const SIN0 = Math.sin(ORIGIN.lat * RAD);
const COS0 = Math.cos(ORIGIN.lat * RAD);

type Point = { visible: boolean; x: number; y: number };

function project(lat: number, lon: number): Point {
  const sinLat = Math.sin(lat * RAD);
  const cosLat = Math.cos(lat * RAD);
  const delta = (lon - ORIGIN.lon) * RAD;
  const cosDelta = Math.cos(delta);

  return {
    visible: SIN0 * sinLat + COS0 * cosLat * cosDelta > 0,
    x: CENTER.x + GLOBE_RADIUS * cosLat * Math.sin(delta),
    y: CENTER.y - GLOBE_RADIUS * (COS0 * sinLat - SIN0 * cosLat * cosDelta),
  };
}

function inView(x: number, y: number): boolean {
  return x >= -MARGIN && x <= VIEW.width + MARGIN && y >= -MARGIN && y <= VIEW.height + MARGIN;
}

/** Longitude steps widen toward the poles so dot density stays even. */
function dotField(): string {
  const dots: string[] = [];

  for (let lat = -88; lat <= 88; lat += DOT_STEP) {
    const ring = Math.max(1, Math.round((360 * Math.cos(lat * RAD)) / DOT_STEP));
    const lonStep = 360 / ring;

    for (let k = -ring / 2; k < ring / 2; k += 1) {
      const point = project(lat, ORIGIN.lon + k * lonStep);
      if (!point.visible || !inView(point.x, point.y)) continue;
      dots.push(`M${point.x.toFixed(1)} ${point.y.toFixed(1)}h0`);
    }
  }

  return dots.join('');
}

/** Hairline meridians and parallels; without them the dots read as flat texture. */
function graticuleLines(): string {
  const arcs: string[] = [];

  const trace = (points: Point[]) => {
    let path = '';
    let drawing = false;
    let seen = false;

    for (const point of points) {
      if (!point.visible) {
        drawing = false;
        continue;
      }
      if (inView(point.x, point.y)) seen = true;
      path += `${drawing ? 'L' : 'M'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
      drawing = true;
    }

    if (seen) arcs.push(path);
  };

  for (let lon = -180; lon < 180; lon += LINE_STEP) {
    const points: Point[] = [];
    for (let lat = -88; lat <= 88; lat += LINE_SAMPLE) {
      points.push(project(lat, ORIGIN.lon + lon));
    }
    trace(points);
  }

  for (let lat = -84; lat <= 84; lat += LINE_STEP) {
    const points: Point[] = [];
    for (let lon = -180; lon <= 180; lon += LINE_SAMPLE) {
      points.push(project(lat, ORIGIN.lon + lon));
    }
    trace(points);
  }

  return arcs.join('');
}

// Pure geometry: built once per process, never per render.
const DOTS = dotField();
const LINES = graticuleLines();

const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='4' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='200' height='200' filter='url(%23g)'/%3E%3C/svg%3E\")";

/*
 * The site is light-only, so its line colour, dot colour and bloom are all
 * literals. Here the palette is a choice, and the two values the tokens do not
 * carry — the graticule's opacity and the bloom — are declared per scheme on
 * the wrapper and consumed below, once each.
 *
 * `.dark` and nothing else, which is the same rule the token layer follows:
 * the class is resolved in JavaScript before the first paint and is already
 * correct for `system` on a dark Mac, so a `prefers-color-scheme` route adds
 * no case — it only subtracts one, by painting a dark bloom onto the light
 * window of someone who chose Light while their Mac is dark.
 */
const SCHEME =
  '[--graticule:0.07] [--bloom:rgba(255,255,255,0.75)] ' +
  'dark:[--graticule:0.06] dark:[--bloom:rgba(91,141,238,0.1)]';

export function Backdrop(): ReactElement {
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 z-0 transform-gpu overflow-hidden text-foreground ${SCHEME}`}>
      <svg
        viewBox={`0 0 ${VIEW.width} ${VIEW.height}`}
        preserveAspectRatio="xMidYMid slice"
        className="absolute inset-0 h-full w-full"
        style={{
          maskImage: 'radial-gradient(ellipse 90% 80% at 50% 44%, #000 35%, transparent 92%)',
        }}
        role="presentation">
        {/*
          `non-scaling-stroke` keeps both layers one device pixel wide however
          far `slice` has scaled the viewBox up.
        */}
        <path
          d={LINES}
          stroke="currentColor"
          style={{ strokeOpacity: 'var(--graticule)' }}
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
          fill="none"
        />
        <path
          d={DOTS}
          stroke="var(--color-dots)"
          strokeWidth="2.4"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          fill="none"
        />
      </svg>

      {/* The two hairlines that mark the 56rem content column. */}
      <div className="absolute inset-0 flex justify-center px-5 sm:px-6">
        <div className="h-full w-full max-w-4xl border-x border-foreground/[0.06]" />
      </div>

      {/* Light behind the headline, so the hero reads off a lifted ground. */}
      <div
        className="absolute inset-x-0 top-0 h-[70%]"
        style={{
          background:
            'radial-gradient(ellipse 42% 56% at 50% 32%, var(--bloom), transparent 72%)',
        }}
      />

      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 78% 68% at 50% 42%, transparent 45%, rgba(122,104,74,0.06) 100%)',
        }}
      />

      <div
        className="absolute inset-0 opacity-[0.07]"
        style={{ backgroundImage: GRAIN, backgroundSize: '200px 200px' }}
      />

      <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-b from-transparent to-background sm:h-56" />
    </div>
  );
}
