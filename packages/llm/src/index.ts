/*
 * @quorum/llm
 *
 * Provider routing, and the one place a model is allowed to look at something
 * and say what it saw. Everything here produces INTERPRETATIONS, never
 * receipts. See vision.ts for why that distinction is enforced by the types
 * rather than by a convention.
 */

export { DEFAULT_VISION_MODEL, VISION_MODELS, readImage, visionConfigured } from './vision.ts';
export { askClaimsLive, expandSubjectLive, readImageLive } from './reader.ts';
export { CLAIMS_MODELS, askClaims, claimsConfigured, parseModelJson } from './claims.ts';
export type { ClaimsOptions, ClaimsTransport } from './claims.ts';
export { EXPANSION_MODELS, expandSubject, expansionConfigured, parseExpansion } from './expand.ts';
export type { ExpandOptions, ExpansionResult, SubjectExpansion } from './expand.ts';
export type { ReaderOptions } from './reader.ts';
export type { ImageReading, ReadingKind, VisionOptions, VisionResult } from './vision.ts';
