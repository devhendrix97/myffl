create table if not exists scoring_statistic_definitions (
  statistic_key text primary key,
  display_name text not null,
  description text not null,
  category text not null,
  unit_label text not null,
  default_calculation_type text not null,
  allowed_calculation_types_json text not null,
  allowed_positions_json text not null,
  display_order integer not null,
  active integer not null default 1
);

create table if not exists scoring_presets (
  preset_key text primary key,
  display_name text not null,
  description text not null,
  display_order integer not null,
  active integer not null default 1
);

create table if not exists scoring_preset_rules (
  preset_key text not null references scoring_presets(preset_key),
  statistic_key text not null references scoring_statistic_definitions(statistic_key),
  enabled integer not null,
  calculation_type text not null,
  point_value_milli integer not null,
  increment_value text,
  threshold_value text,
  positions_json text not null default '[]',
  max_awards integer,
  tiers_json text not null default '[]',
  display_order integer not null,
  primary key (preset_key, statistic_key)
);

insert or replace into scoring_statistic_definitions values
  ('passing_yards', 'Passing yards', 'Points earned for yards gained on completed passes.', 'Passing', 'yards', 'points-per-unit', '["points-per-unit","one-time-threshold","repeating-threshold","tiered"]', '["QB"]', 10, 1),
  ('passing_touchdowns', 'Passing touchdowns', 'Points earned each time a pass results in a touchdown.', 'Passing', 'touchdowns', 'flat-per-event', '["flat-per-event","tiered"]', '["QB"]', 20, 1),
  ('interceptions_thrown', 'Interceptions thrown', 'Penalty applied when a pass is intercepted by the defense.', 'Passing', 'interceptions', 'flat-per-event', '["flat-per-event","tiered"]', '["QB"]', 30, 1),
  ('rushing_yards', 'Rushing yards', 'Points earned for yards gained while carrying the ball.', 'Rushing', 'yards', 'points-per-unit', '["points-per-unit","one-time-threshold","repeating-threshold","tiered"]', '["QB","RB","WR","TE"]', 40, 1),
  ('rushing_touchdowns', 'Rushing touchdowns', 'Points earned each time a player runs the ball into the end zone.', 'Rushing', 'touchdowns', 'flat-per-event', '["flat-per-event","tiered"]', '["QB","RB","WR","TE"]', 50, 1),
  ('receptions', 'Receptions', 'Points earned for each completed pass caught by a player.', 'Receiving', 'receptions', 'flat-per-event', '["flat-per-event","position-specific"]', '["RB","WR","TE"]', 60, 1),
  ('tight_end_reception_bonus', 'Tight end reception bonus', 'Extra points added to every reception made by a tight end.', 'Receiving', 'receptions', 'position-specific', '["position-specific"]', '["TE"]', 65, 1),
  ('receiving_yards', 'Receiving yards', 'Points earned for yards gained after catching a pass.', 'Receiving', 'yards', 'points-per-unit', '["points-per-unit","one-time-threshold","repeating-threshold","tiered"]', '["RB","WR","TE"]', 70, 1),
  ('receiving_touchdowns', 'Receiving touchdowns', 'Points earned each time a caught pass results in a touchdown.', 'Receiving', 'touchdowns', 'flat-per-event', '["flat-per-event","tiered"]', '["RB","WR","TE"]', 80, 1),
  ('two_point_conversions', 'Two-point conversions', 'Points earned by scoring or passing on a two-point attempt.', 'Offense', 'conversions', 'flat-per-event', '["flat-per-event"]', '["QB","RB","WR","TE"]', 90, 1),
  ('fumbles_lost', 'Fumbles lost', 'Penalty applied when a player fumbles and the opponent recovers.', 'Fumbles', 'fumbles', 'flat-per-event', '["flat-per-event"]', '["QB","RB","WR","TE","K"]', 100, 1),
  ('field_goals_made', 'Field goals made', 'Points earned for each successful field goal.', 'Kicking', 'field goals', 'flat-per-event', '["flat-per-event","range-based","tiered"]', '["K"]', 110, 1),
  ('extra_points_made', 'Extra points made', 'Points earned for each successful point-after kick.', 'Kicking', 'extra points', 'flat-per-event', '["flat-per-event"]', '["K"]', 120, 1),
  ('defense_sacks', 'Team defense sacks', 'Points earned when the team defense records a sack.', 'Team Defense', 'sacks', 'flat-per-event', '["flat-per-event"]', '["DST"]', 130, 1),
  ('defense_interceptions', 'Team defense interceptions', 'Points earned when the team defense intercepts a pass.', 'Team Defense', 'interceptions', 'flat-per-event', '["flat-per-event"]', '["DST"]', 140, 1),
  ('defense_fumble_recoveries', 'Team defense fumble recoveries', 'Points earned when the team defense recovers a fumble.', 'Team Defense', 'recoveries', 'flat-per-event', '["flat-per-event"]', '["DST"]', 150, 1),
  ('defense_touchdowns', 'Team defense touchdowns', 'Points earned when the team defense or special teams scores.', 'Team Defense', 'touchdowns', 'flat-per-event', '["flat-per-event"]', '["DST"]', 160, 1),
  ('idp_solo_tackles', 'Solo tackles', 'Points earned by an individual defender for an unassisted tackle.', 'Individual Defense', 'tackles', 'flat-per-event', '["flat-per-event"]', '["DL","LB","DB"]', 170, 1),
  ('idp_assisted_tackles', 'Assisted tackles', 'Points earned by an individual defender for assisting on a tackle.', 'Individual Defense', 'tackles', 'flat-per-event', '["flat-per-event"]', '["DL","LB","DB"]', 180, 1),
  ('idp_sacks', 'Individual sacks', 'Points earned by an individual defender for a sack.', 'Individual Defense', 'sacks', 'flat-per-event', '["flat-per-event"]', '["DL","LB","DB"]', 190, 1),
  ('idp_interceptions', 'Individual interceptions', 'Points earned by an individual defender for an interception.', 'Individual Defense', 'interceptions', 'flat-per-event', '["flat-per-event"]', '["DL","LB","DB"]', 200, 1);

insert or replace into scoring_presets values
  ('standard', 'Standard', 'Receptions earn no points. Players score through yards, touchdowns, kicking, and defense.', 10, 1),
  ('half-ppr', 'Half PPR', 'Each catch earns 0.5 points, balancing volume receivers with runners and touchdown scorers.', 20, 1),
  ('full-ppr', 'Full PPR', 'Each catch earns 1 point, increasing the value of high-volume receivers and pass-catching backs.', 30, 1),
  ('superflex', 'Superflex', 'Full PPR scoring paired with a roster spot that can start a quarterback, making quarterbacks more valuable.', 40, 1),
  ('te-premium', 'TE Premium', 'Full PPR scoring with an extra 0.5 points per tight end reception.', 50, 1),
  ('idp', 'IDP', 'Full PPR offense plus individual defensive players scoring tackles, sacks, and interceptions.', 60, 1);

insert or replace into scoring_preset_rules
  (preset_key, statistic_key, enabled, calculation_type, point_value_milli, increment_value, threshold_value, positions_json, max_awards, tiers_json, display_order)
select 'standard', statistic_key,
  case when category = 'Individual Defense' or statistic_key = 'tight_end_reception_bonus' then 0 else 1 end,
  default_calculation_type,
  case statistic_key
    when 'passing_yards' then 40 when 'passing_touchdowns' then 4000 when 'interceptions_thrown' then -2000
    when 'rushing_yards' then 100 when 'rushing_touchdowns' then 6000 when 'receptions' then 0
    when 'tight_end_reception_bonus' then 0 when 'receiving_yards' then 100 when 'receiving_touchdowns' then 6000
    when 'two_point_conversions' then 2000 when 'fumbles_lost' then -2000 when 'field_goals_made' then 3000
    when 'extra_points_made' then 1000 when 'defense_sacks' then 1000 when 'defense_interceptions' then 2000
    when 'defense_fumble_recoveries' then 2000 when 'defense_touchdowns' then 6000
    when 'idp_solo_tackles' then 1000 when 'idp_assisted_tackles' then 500 when 'idp_sacks' then 3000
    when 'idp_interceptions' then 3000 else 0 end,
  case when default_calculation_type = 'points-per-unit' then '1' else null end,
  null, allowed_positions_json, null, '[]', display_order
from scoring_statistic_definitions;

insert or replace into scoring_preset_rules
select preset.preset_key, base.statistic_key, base.enabled, base.calculation_type,
  case
    when base.statistic_key = 'receptions' and preset.preset_key = 'half-ppr' then 500
    when base.statistic_key = 'receptions' and preset.preset_key in ('full-ppr','superflex','te-premium','idp') then 1000
    when base.statistic_key = 'tight_end_reception_bonus' and preset.preset_key = 'te-premium' then 500
    else base.point_value_milli end,
  base.increment_value, base.threshold_value, base.positions_json, base.max_awards, base.tiers_json, base.display_order
from scoring_presets preset
cross join scoring_preset_rules base
where base.preset_key = 'standard' and preset.preset_key <> 'standard';

update scoring_preset_rules set enabled = 1
where preset_key = 'te-premium' and statistic_key = 'tight_end_reception_bonus';
update scoring_preset_rules set enabled = 1
where preset_key = 'idp' and statistic_key like 'idp_%';

create index if not exists idx_scoring_statistics_category
  on scoring_statistic_definitions(category, display_order);
create index if not exists idx_scoring_preset_rules_order
  on scoring_preset_rules(preset_key, display_order);
