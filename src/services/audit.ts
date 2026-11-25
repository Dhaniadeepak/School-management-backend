import type { AuthContext } from '../middleware/auth';
import { AuditLog } from '../models';

/** Records who changed attendance, results or fees, with old and new values. */
export async function audit(
  who: Pick<AuthContext, 'userId' | 'schoolId'>,
  action: string,
  entity: string,
  entityId: string | undefined,
  oldValue?: unknown,
  newValue?: unknown,
): Promise<void> {
  await AuditLog.create({ schoolId: who.schoolId, userId: who.userId, action, entity, entityId, oldValue, newValue });
}
