CREATE OR REPLACE FUNCTION prevent_deployment_source_preparation_changes()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.checkout_removed_at IS NULL
    AND NEW.checkout_removed_at IS NOT NULL
    AND (to_jsonb(NEW) - 'checkout_removed_at') = (to_jsonb(OLD) - 'checkout_removed_at')
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = 'check_violation',
    MESSAGE = 'prepared deployment source metadata is immutable';
END;
$$;
