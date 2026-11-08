export class ArtifactCollisionError extends Error {
  constructor(message: string, readonly collisions: string[]) {
    super(message);
    this.name = "ArtifactCollisionError";
  }
}

export class StaleOverrideError extends ArtifactCollisionError {
  constructor(message: string, selectors: string[]) {
    super(message, selectors);
    this.name = "StaleOverrideError";
  }
}
