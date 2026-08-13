alter table fantasypros_rankings add column bye_week integer;
alter table fantasypros_rankings add column source_scope text not null default 'API';
