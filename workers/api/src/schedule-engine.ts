export function roundRobinPairings(teamIds: string[]): Array<Array<[string, string | null]>> {
  const teams: Array<string | null> = [...teamIds];
  if (teams.length % 2) teams.push(null);
  if (teams.length < 2) return [];
  const rounds: Array<Array<[string, string | null]>> = [];
  for (let round = 0; round < teams.length - 1; round++) {
    const pairs: Array<[string, string | null]> = [];
    for (let index = 0; index < teams.length / 2; index++) {
      const left = teams[index]; const right = teams[teams.length - 1 - index];
      if (left) pairs.push([left, right]); else if (right) pairs.push([right, null]);
    }
    rounds.push(pairs);
    teams.splice(1, 0, teams.pop()!);
  }
  return rounds;
}

export function shuffleTeamIds(teamIds: string[], randomValue: () => number = cryptoRandomValue): string[] {
  const shuffled = [...teamIds];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(randomValue() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function cryptoRandomValue(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] / 0x1_0000_0000;
}

export function bracketSeedOrder(size: number): number[] {
  let order = [1, 2];
  while (order.length < size) {
    const nextSize = order.length * 2 + 1;
    order = order.flatMap((seed) => [seed, nextSize - seed]);
  }
  return order;
}
