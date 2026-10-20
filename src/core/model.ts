/**
 * The neutral intermediate model every reader produces and every writer consumes.
 * Because all formats meet here, any reader can be paired with any writer.
 *
 * Conventions
 *  - Footprints and boards: millimetres, Y axis pointing DOWN (screen / KiCad PCB convention).
 *  - Symbols: millimetres, Y axis pointing UP (KiCad symbol / Eagle convention).
 *  - Angles in degrees, counter-clockwise as seen on screen.
 *  - Layers use KiCad's canonical names (F.Cu, B.SilkS, Edge.Cuts, In1.Cu ...) because they are
 *    the most fine-grained common vocabulary; every reader/writer maps to and from them.
 */

export interface Pt { x: number; y: number }

export type Layer = string;

interface GraphicBase { layer: Layer; width: number; fill?: boolean }
export interface Line extends GraphicBase { type: 'line'; a: Pt; b: Pt }
/** Three-point arc: start, any point on the arc (mid), end. Survives mirroring and rotation unchanged. */
export interface Arc extends GraphicBase { type: 'arc'; start: Pt; mid: Pt; end: Pt }
export interface Circle extends GraphicBase { type: 'circle'; center: Pt; radius: number }
export interface Rect extends GraphicBase { type: 'rect'; a: Pt; b: Pt }
export interface Poly extends GraphicBase { type: 'poly'; pts: Pt[]; closed: boolean }
export interface Text extends GraphicBase {
  type: 'text'; at: Pt; text: string; size: number; rotation: number; mirror?: boolean;
  role?: 'reference' | 'value' | 'user'; hidden?: boolean;
  /** horizontal anchor */ justify?: 'left' | 'center' | 'right';
}
export type Graphic = Line | Arc | Circle | Rect | Poly | Text;

export type PadShape = 'circle' | 'rect' | 'oval' | 'roundrect' | 'octagon' | 'custom';
export interface Pad {
  number: string;
  kind: 'smd' | 'thru' | 'npth';
  shape: PadShape;
  at: Pt;
  /** Rotation relative to the footprint. */
  rotation: number;
  w: number; h: number;
  drill?: { w: number; h: number };
  /** For SMD pads: which copper side. Through-hole pads span all copper layers. */
  side: 'F' | 'B';
  roundRatio?: number;
  /** Custom pad outline, relative to `at`, unrotated. `w`/`h` are then the outline's extent. */
  poly?: Pt[];
  /** Custom pads: size of the anchor shape, when known. */
  anchor?: number;
  net?: string;
  /** Extra layers (paste/mask) were explicitly suppressed. */
  noPaste?: boolean; noMask?: boolean;
}

export interface Model3D { path: string; offset: [number, number, number]; rotation: [number, number, number]; scale?: [number, number, number] }

export interface Footprint {
  name: string;
  description?: string;
  pads: Pad[];
  graphics: Graphic[];
  /** Board-only cutouts / keepouts that live in the footprint */
  holes?: { at: Pt; d: number }[];
  model3d?: Model3D[];
}

export type PinType = 'input' | 'output' | 'bidirectional' | 'tri_state' | 'passive' | 'power_in' | 'power_out'
  | 'open_collector' | 'open_emitter' | 'unspecified' | 'no_connect';

export interface Pin {
  number: string; name: string;
  /** Electrical connection point. */
  at: Pt;
  length: number;
  /** Direction from the connection point towards the body: 0 = right, 90 = up, 180 = left, 270 = down. */
  angle: number;
  type: PinType;
  hidden?: boolean;
  shape?: 'line' | 'inverted' | 'clock' | 'inverted_clock';
}

export interface SymbolUnit { name?: string; graphics: Graphic[]; pins: Pin[] }

export interface Symbol {
  name: string;
  reference: string;
  value?: string;
  footprint?: string;
  datasheet?: string;
  description?: string;
  properties: Record<string, string>;
  units: SymbolUnit[];
  /** Power symbols, etc. */
  power?: boolean;
}

export interface PlacedFootprint {
  ref: string; value: string;
  at: Pt; rotation: number;
  side: 'top' | 'bottom';
  /** Footprint geometry in local coordinates *as placed*: for bottom-side parts it is already
   *  mirrored and on B.* layers (like KiCad stores it). world = at + rotate(local, rotation). */
  footprint: Footprint;
  /** Reference/value label positions, local coordinates. */
  texts?: Text[];
  locked?: boolean;
}

export interface Track { layer: Layer; width: number; a: Pt; b: Pt; mid?: Pt; net?: string }
export interface Via { at: Pt; size: number; drill: number; net?: string; from?: Layer; to?: Layer }
export interface Zone { layer: Layer; net?: string; outline: Pt[]; clearance?: number; minWidth?: number; keepout?: boolean; priority?: number }

export interface Board {
  name: string;
  copperLayers: number;
  footprints: PlacedFootprint[];
  tracks: Track[];
  vias: Via[];
  zones: Zone[];
  /** Board-level drawings: outline (Edge.Cuts), silkscreen, docs ... */
  graphics: Graphic[];
  holes: { at: Pt; d: number }[];
  nets: string[];
}

export interface Library { symbols: Symbol[]; footprints: Footprint[] }

export type Design =
  | { kind: 'library'; name: string; library: Library }
  | { kind: 'board'; name: string; board: Board };

export interface InputFile { name: string; data: Uint8Array | string }
export interface OutputFile { name: string; data: string | Uint8Array }
