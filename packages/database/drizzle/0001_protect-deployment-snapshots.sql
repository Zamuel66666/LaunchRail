CREATE FUNCTION prevent_deployment_snapshot_changes()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.retry_of_deployment_id IS DISTINCT FROM OLD.retry_of_deployment_id
    OR NEW.source_revision IS DISTINCT FROM OLD.source_revision
    OR NEW.source_snapshot IS DISTINCT FROM OLD.source_snapshot
    OR NEW.configuration_snapshot IS DISTINCT FROM OLD.configuration_snapshot
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'deployment source and configuration snapshots are immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER deployments_immutable_snapshot
BEFORE UPDATE ON deployments
FOR EACH ROW
EXECUTE FUNCTION prevent_deployment_snapshot_changes();
