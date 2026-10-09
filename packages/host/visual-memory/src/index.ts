/**
 * dsh-spm-visual-memory — the session's lossless visual memory and the tools
 * that let the model look again (VISUAL-HARNESS, decision D12).
 *
 * Pure core (no dsh imports): frame ids, `.sxm` ingestion, display geometry,
 * flattening, rendering, PNG, the directory archive, the notes store and the
 * `inspect` / `read_values` logic.
 */
export {
  FRAME_KINDS,
  FrameIdError,
  KIND_WORDS,
  frameId,
  isFrameId,
  isFrameKind,
  parseFrameId,
  type FrameKind,
  type ParsedFrameId,
} from './frame-id.js'
export { pyFixed, pyG, pyRound, pyRoundInt, rint } from './pyfmt.js'
export { PngError, crc32, decodePng, encodePngRgb, pngSize, toRgb, type DecodedPng, type PngOptions } from './png.js'
export {
  DISPLAY_MAX_DEFAULT,
  GeometryError,
  checkGeometry,
  displaySize,
  displayToScanNm,
  nativeToScanNm,
  scaleFromValue,
  scalePair,
  scaleText,
  scaleValue,
  scanNmToDisplay,
  scanNmToNative,
  type ScalePair,
  type ScanGeometry,
} from './geometry.js'
export { UNIT_LADDER, columnUnit, displayUnit, maxAbs, roundValue, stripUnit, unitForChannel, type DisplayUnit } from './units.js'
export { CONSTANT_HEIGHT_Z_RANGE_M, ChannelError, defaultChannel, findChannel, resolveChannel, span } from './channels.js'
export {
  FLATTEN_MODES,
  FlattenError,
  HIGHPASS_NM_DEFAULT,
  blockMean,
  fitSurface,
  flatten,
  isFlattenMode,
  medianBackground,
  nanMedian,
  projectOnto,
  rowOffsets,
  type FlattenMode,
  type FlattenOptions,
  type Grid,
} from './flatten.js'
export {
  CLIP_PCT_DEFAULT,
  NAN_NAME,
  NAN_RGB,
  RegionError,
  colourLimits,
  crop,
  fmtNum,
  greyRgb,
  percentileSorted,
  planView,
  rangeAttr,
  regionToNative,
  renderValues,
  upscaleRgb,
  viewCornersNm,
  visualLabel,
  type LabelAttr,
  type Region,
  type RenderedValues,
  type View,
} from './render.js'
export { NpyShapeError, decodeNpyFloat32, encodeNpyFloat32, type Float32Grid } from './npy32.js'
export {
  DIRECTIONS,
  IngestError,
  arrayKey,
  frameGeometry,
  isDirection,
  loadSxm,
  scanFromArrays,
  sxmChannelUnits,
  type ArrayInput,
  type Direction,
  type PartialGeometry,
  type PartialMeta,
  type ScanData,
} from './scan-data.js'
export { encodeSyntheticSxm, type SyntheticChannel, type SyntheticSxm } from './synthetic-sxm.js'
export {
  ArchiveError,
  FrameArchive,
  INDEX_NAME,
  channelDirections,
  entryScale,
  entrySummary,
  hasValues,
  kindWord,
  mergeAttrs,
  type ArchiveOptions,
  type DerivedMeta,
  type FrameArray,
  type FrameEntry,
  type FrameExtra,
  type RenderMeta,
  type RenderOptions,
  type Rendered,
} from './archive.js'
export {
  GUIDE_FILE,
  GUIDE_INITIAL,
  MAX_GUIDE_BYTES,
  MAX_WORKING_BYTES,
  NOTE_FILES,
  NotesError,
  NotesStore,
  WORKING_FILE,
  isNoteFile,
  noteLimit,
  type NoteFile,
  type NoteWrite,
} from './notes.js'
