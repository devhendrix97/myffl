import type { ScoringCalculationType } from "@myffl/api-contracts";

export const SCORING_CALCULATION_VERSION = "myffl-scoring-1.0.0";

export interface EngineTier {
  minimum: string;
  maximum?: string;
  points: string;
}

export interface EngineRule {
  scoringRuleId: string;
  statisticKey: string;
  displayName: string;
  enabled: boolean;
  calculationType: ScoringCalculationType;
  pointValueMilli: number;
  incrementValue?: string;
  thresholdValue?: string;
  positions: string[];
  maxAwards?: number;
  tiers: EngineTier[];
  displayOrder: number;
}

export interface ScoreComponent {
  scoringRuleId: string;
  statisticKey: string;
  displayName: string;
  rawValue: number | number[];
  pointsMilli: number;
  explanation: string;
  displayOrder: number;
}

export interface ScoreCalculation {
  totalPointsMilli: number;
  components: ScoreComponent[];
  normalizedStats: Record<string, number | number[]>;
}

const directKeys: Record<string, string[]> = {
  passing_yards: ["passing:YDS"],
  passing_touchdowns: ["passing:TD"],
  interceptions_thrown: ["passing:INT"],
  rushing_yards: ["rushing:YDS"],
  rushing_touchdowns: ["rushing:TD"],
  receptions: ["receiving:REC"],
  tight_end_reception_bonus: ["receiving:REC"],
  receiving_yards: ["receiving:YDS"],
  receiving_touchdowns: ["receiving:TD"],
  two_point_conversions: ["general:2PT", "miscellaneous:2PT", "scoring:2PT"],
  fumbles_lost: ["fumbles:LST", "fumbles:LOST"],
  defense_sacks: ["defensive:SACKS", "defense:SACKS"],
  defense_interceptions: ["defensive:INT", "defense:INT"],
  defense_fumble_recoveries: ["defensive:FR", "defense:FR"],
  defense_touchdowns: ["defensive:TD", "defense:TD"],
  idp_solo_tackles: ["defensive:SOLO"],
  idp_assisted_tackles: ["defensive:AST"],
  idp_sacks: ["defensive:SACKS"],
  idp_interceptions: ["defensive:INT"],
};

export function normalizeProviderStats(stats: Record<string, unknown>): Record<string, number | number[]> {
  const normalized: Record<string, number | number[]> = {};
  for (const [statisticKey, providerKeys] of Object.entries(directKeys)) {
    const value = providerKeys.map((key) => stats[key]).find((candidate) => candidate !== undefined && candidate !== null);
    normalized[statisticKey] = numeric(value);
  }
  normalized.field_goals_made = compoundMade(stats["kicking:FG"]);
  normalized.extra_points_made = compoundMade(stats["kicking:XP"]);
  if (Array.isArray(stats["myffl:field_goal_distances"])) {
    normalized.field_goals_made = (stats["myffl:field_goal_distances"] as unknown[]).map(numeric);
  }
  return normalized;
}

export function calculatePlayerScore(
  stats: Record<string, unknown>,
  position: string | null | undefined,
  rules: EngineRule[],
): ScoreCalculation {
  const normalizedStats = normalizeProviderStats(stats);
  const components = rules
    .filter((rule) => rule.enabled && appliesToPosition(rule, position))
    .map((rule) => calculateRule(rule, normalizedStats[rule.statisticKey] ?? 0))
    .filter((component) => component.pointsMilli !== 0);
  return {
    totalPointsMilli: components.reduce((total, component) => total + component.pointsMilli, 0),
    components,
    normalizedStats,
  };
}

function calculateRule(rule: EngineRule, rawValue: number | number[]): ScoreComponent {
  const values = Array.isArray(rawValue) ? rawValue : [rawValue];
  const scalar = Array.isArray(rawValue) ? rawValue.length : rawValue;
  let pointsMilli = 0;
  let detail = "no award";
  switch (rule.calculationType) {
    case "points-per-unit": {
      const increment = positiveNumber(rule.incrementValue, 1);
      pointsMilli = Math.round((scalar / increment) * rule.pointValueMilli);
      detail = `${formatNumber(scalar)} / ${formatNumber(increment)} units`;
      break;
    }
    case "flat-per-event":
    case "position-specific":
      pointsMilli = Math.round(scalar * rule.pointValueMilli);
      detail = `${formatNumber(scalar)} event${Math.abs(scalar) === 1 ? "" : "s"}`;
      break;
    case "one-time-threshold":
    case "minimum-requirement": {
      const threshold = number(rule.thresholdValue);
      const awarded = scalar >= threshold ? 1 : 0;
      pointsMilli = awarded * rule.pointValueMilli;
      detail = `${formatNumber(scalar)} ${awarded ? "reached" : "did not reach"} ${formatNumber(threshold)}`;
      break;
    }
    case "repeating-threshold": {
      const threshold = positiveNumber(rule.thresholdValue, 1);
      const awards = capAwards(Math.floor(scalar / threshold), rule.maxAwards);
      pointsMilli = awards * rule.pointValueMilli;
      detail = `${awards} award${awards === 1 ? "" : "s"} at ${formatNumber(threshold)}`;
      break;
    }
    case "maximum-award": {
      const awards = capAwards(Math.floor(scalar), rule.maxAwards);
      pointsMilli = awards * rule.pointValueMilli;
      detail = `${awards} capped award${awards === 1 ? "" : "s"}`;
      break;
    }
    case "tiered": {
      const tier = matchingTier(rule.tiers, scalar);
      pointsMilli = tier ? pointValueMilli(tier.points) : 0;
      detail = tier ? `tier ${tier.minimum}${tier.maximum === undefined ? "+" : `-${tier.maximum}`}` : "no matching tier";
      break;
    }
    case "range-based": {
      const awards = values.map((value) => matchingTier(rule.tiers, value)).filter((tier): tier is EngineTier => Boolean(tier));
      pointsMilli = awards.reduce((total, tier) => total + pointValueMilli(tier.points), 0);
      detail = `${awards.length} range award${awards.length === 1 ? "" : "s"}`;
      break;
    }
  }
  return {
    scoringRuleId: rule.scoringRuleId,
    statisticKey: rule.statisticKey,
    displayName: rule.displayName,
    rawValue,
    pointsMilli,
    explanation: `${rule.displayName}: ${detail}`,
    displayOrder: rule.displayOrder,
  };
}

function appliesToPosition(rule: EngineRule, position: string | null | undefined): boolean {
  return rule.positions.length === 0 || Boolean(position && rule.positions.includes(position));
}

function matchingTier(tiers: EngineTier[], value: number): EngineTier | undefined {
  return tiers.find((tier) => value >= number(tier.minimum) && (tier.maximum === undefined || value <= number(tier.maximum)));
}

function numeric(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number.parseFloat(String(value ?? "0").replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function compoundMade(value: unknown): number {
  const match = String(value ?? "0").match(/^(-?\d+(?:\.\d+)?)\s*[\/-]/);
  return match ? numeric(match[1]) : numeric(value);
}

function number(value: unknown): number {
  return numeric(value);
}

function positiveNumber(value: unknown, fallback: number): number {
  const parsed = number(value);
  return parsed > 0 ? parsed : fallback;
}

function capAwards(value: number, maximum?: number): number {
  return Math.max(0, maximum === undefined ? value : Math.min(value, maximum));
}

function pointValueMilli(value: string): number {
  return Math.round(number(value) * 1000);
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
}
