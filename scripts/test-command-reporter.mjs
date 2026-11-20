import { writeFileSync } from "node:fs";

// Uses runner-owned IDs, including parameter expansion, rather than source-text guesses.
export default class CommandMatrixReporter {
  registered = new Map();
  onTestModuleCollected(module) {
    for (const test of module.children.allTests()) {
      if (this.registered.has(test.id)) throw new Error(`Duplicate runner test ID: ${test.id}`);
      this.registered.set(test.id, {
        id: test.id, file: module.relativeModuleId, name: test.fullName,
        expectedFailure: test.options.fails === true,
      });
    }
  }
  onTestRunEnd(modules, errors, reason) {
    const tests = [];
    for (const module of modules) for (const test of module.children.allTests()) {
      const registered = this.registered.get(test.id);
      if (!registered) throw new Error(`Unregistered runner test: ${test.id}`);
      tests.push({ ...registered, status: test.result().state });
    }
    writeFileSync(process.env.COMMAND_MATRIX_REPORT, JSON.stringify({
      registered: [...this.registered.values()], tests, reason,
      moduleErrors: modules.filter(module => !module.ok()).map(module => module.relativeModuleId),
      unhandledErrors: errors.length,
    }));
  }
}
