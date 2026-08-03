create table if not exists roster_position_limits (
  roster_position_limit_id text primary key,
  roster_definition_id text not null references roster_definitions(roster_definition_id),
  position text not null,
  display_name text not null,
  minimum_count integer not null,
  maximum_count integer not null,
  display_order integer not null,
  unique(roster_definition_id, position)
);

create index if not exists idx_roster_position_limits_definition
  on roster_position_limits(roster_definition_id, display_order);

insert or ignore into roster_position_limits (
  roster_position_limit_id, roster_definition_id, position, display_name,
  minimum_count, maximum_count, display_order
)
with positions(position, display_name, display_order) as (
  values
    ('QB', 'Quarterback', 10), ('RB', 'Running Back', 20),
    ('WR', 'Wide Receiver', 30), ('TE', 'Tight End', 40),
    ('K', 'Kicker', 50), ('DST', 'Team Defense', 60),
    ('DL', 'Defensive Line', 70), ('LB', 'Linebacker', 80),
    ('DB', 'Defensive Back', 90)
), active_sizes as (
  select roster_definition_id, sum(slot_count) as active_size
  from roster_slots where slot_type not in ('IR', 'PUP', 'TAXI')
  group by roster_definition_id
)
select
  'rpl_migrated_' || substr(replace(definitions.roster_definition_id, '-', ''), 1, 20) || '_' || positions.position,
  definitions.roster_definition_id,
  positions.position,
  positions.display_name,
  coalesce(sum(case
    when slots.contributes_points = 1
      and slots.eligible_positions_json = '["' || positions.position || '"]'
    then slots.slot_count else 0 end), 0),
  active_sizes.active_size,
  positions.display_order
from roster_definitions definitions
join active_sizes on active_sizes.roster_definition_id = definitions.roster_definition_id
cross join positions
left join roster_slots slots on slots.roster_definition_id = definitions.roster_definition_id
where exists (
  select 1 from roster_slots eligible
  where eligible.roster_definition_id = definitions.roster_definition_id
    and instr(eligible.eligible_positions_json, '"' || positions.position || '"') > 0
)
group by definitions.roster_definition_id, positions.position;
