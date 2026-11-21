-- Kerby's queues in every tenant database: `turns` runs conversation turns, `system` holds maintenance.
select absurd.create_queue('turns');
select absurd.create_queue('system');
