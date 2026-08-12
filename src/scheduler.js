export class KeyPool {
  constructor(keys, cooldownMs) {
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new Error('At least one Browserless key is required');
    }

    this.keys = keys.map((value, index) => ({
      id: index,
      value,
      cooldownUntil: 0,
    }));
    this.cooldownMs = cooldownMs;
    this.cursor = 0;
  }

  pick(now = Date.now()) {
    for (let offset = 0; offset < this.keys.length; offset += 1) {
      const index = (this.cursor + offset) % this.keys.length;
      const key = this.keys[index];
      if (key.cooldownUntil <= now) {
        this.cursor = (index + 1) % this.keys.length;
        return key;
      }
    }
    return null;
  }

  markFailure(key, now = Date.now()) {
    key.cooldownUntil = now + this.cooldownMs;
  }

  markSuccess(key) {
    key.cooldownUntil = 0;
  }

  nextAvailableDelay(now = Date.now()) {
    const soonest = Math.min(...this.keys.map((key) => key.cooldownUntil));
    return Math.max(0, soonest - now);
  }

  status(now = Date.now()) {
    return this.keys.map((key) => ({
      id: key.id,
      coolingDown: key.cooldownUntil > now,
      cooldownRemainingMs: Math.max(0, key.cooldownUntil - now),
    }));
  }
}
