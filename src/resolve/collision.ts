export class ArtifactCollisionError extends Error {
  constructor(message: string, readonly collisions: string[]) {
    super(message);
    this.name = "ArtifactCollisionError";
  }
}
