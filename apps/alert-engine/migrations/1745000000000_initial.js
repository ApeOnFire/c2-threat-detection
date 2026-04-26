/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
export const up = (pgm) => {
  pgm.createTable('alarm_rules', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    event_type: { type: 'text', notNull: true },
    field: { type: 'text', notNull: true },
    operator: { type: 'text', notNull: true },
    threshold: { type: 'numeric' },
    alarm_subtype: { type: 'text', notNull: true },
    enabled: { type: 'boolean', notNull: true, default: true },
  });

  pgm.createTable('alarms', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    event_id: { type: 'text', notNull: true, unique: true },
    device_id: { type: 'text', notNull: true },
    site_id: { type: 'text', notNull: true },
    event_type: { type: 'text', notNull: true },
    alarm_subtype: { type: 'text', notNull: true },
    peak_count_rate: { type: 'numeric' },
    isotope: { type: 'text' },
    status: { type: 'text', notNull: true, default: 'ACTIVE' },
    triggered_at: { type: 'timestamptz', notNull: true },
    acknowledged_at: { type: 'timestamptz' },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });

  pgm.sql(`
    CREATE OR REPLACE FUNCTION notify_alarm_rules_updated()
    RETURNS TRIGGER AS $$
    BEGIN
      PERFORM pg_notify('alarm_rules_updated', '');
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER alarm_rules_updated
    AFTER INSERT OR UPDATE OR DELETE ON alarm_rules
    FOR EACH STATEMENT EXECUTE FUNCTION notify_alarm_rules_updated();
  `);

  // Explicit UUIDs — lexicographic order = evaluation order.
  // NORM_THRESHOLD (0001) evaluated before ISOTOPE_IDENTIFIED (0002).
  pgm.sql(`
    INSERT INTO alarm_rules (id, event_type, field, operator, threshold, alarm_subtype)
    VALUES
      (
        '00000000-0000-0000-0000-000000000001',
        'RADIATION_SCAN',
        'peakCountRate',
        '>',
        250,
        'NORM_THRESHOLD'
      ),
      (
        '00000000-0000-0000-0000-000000000002',
        'RADIATION_SCAN',
        'isotope',
        'IS NOT NULL',
        NULL,
        'ISOTOPE_IDENTIFIED'
      );
  `);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
export const down = (pgm) => {
  pgm.dropTable('alarms');
  pgm.dropTable('alarm_rules');
  pgm.sql('DROP FUNCTION IF EXISTS notify_alarm_rules_updated() CASCADE;');
};
