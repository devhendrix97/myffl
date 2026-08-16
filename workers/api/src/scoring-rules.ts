import type { ScoringCalculationType } from "@myffl/api-contracts";
import type { EngineRule, EngineTier } from "./scoring-engine";

interface RuleRow {
  scoring_rule_id: string;
  statistic_key: string;
  display_name: string;
  enabled: number;
  calculation_type: ScoringCalculationType;
  point_value_milli: number;
  increment_value: string | null;
  threshold_value: string | null;
  position_filter: string | null;
  positions_json: string;
  max_awards: number | null;
  tiers_json: string;
  display_order: number;
}

export async function loadScoringRules(db: D1Database, versionId: string): Promise<EngineRule[]> {
  const result = await db.prepare(
    `select rules.scoring_rule_id, rules.statistic_key, details.display_name, rules.enabled,
            rules.calculation_type, rules.point_value_milli, rules.increment_value,
            rules.threshold_value, rules.position_filter, details.positions_json,
            rules.max_awards, details.tiers_json, rules.display_order
     from scoring_rules rules join scoring_rule_details details on details.scoring_rule_id = rules.scoring_rule_id
     where rules.scoring_version_id = ?1 order by rules.display_order`,
  ).bind(versionId).all<RuleRow>();
  return (result.results ?? []).map((row) => ({
    scoringRuleId: row.scoring_rule_id,
    statisticKey: row.statistic_key,
    displayName: row.display_name,
    enabled: Boolean(row.enabled),
    calculationType: row.calculation_type,
    pointValueMilli: row.point_value_milli,
    incrementValue: row.increment_value ?? undefined,
    thresholdValue: row.threshold_value ?? undefined,
    positions: parseArray<string>(row.positions_json || row.position_filter || "[]"),
    maxAwards: row.max_awards ?? undefined,
    tiers: parseArray<EngineTier>(row.tiers_json),
    displayOrder: row.display_order,
  }));
}

function parseArray<T>(value: string): T[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}
