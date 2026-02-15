import { AuditLogger, AuditCategory, createElectronicSignature, verifyElectronicSignature } from '../audit-logger';

describe('AuditLogger', () => {
  const signingKey = 'test-signing-key-for-audit';
  let logger: AuditLogger;

  beforeEach(() => {
    logger = new AuditLogger(signingKey);
  });

  it('should create an audit entry', () => {
    const entry = logger.log({
      category: AuditCategory.DATA_MODIFICATION,
      action: 'tag.write',
      resourceType: 'tag',
      resourceId: 'Temperature_PV',
      userId: 'user-1',
      username: 'operator1',
      previousValue: 72.5,
      newValue: 75.0,
    });

    expect(entry.id).toBeDefined();
    expect(entry.category).toBe(AuditCategory.DATA_MODIFICATION);
    expect(entry.signatures).toHaveLength(1);
    expect(entry.entryHash).toBeDefined();
    expect(entry.previousEntryHash).toBe('0'.repeat(64));
  });

  it('should chain entry hashes', () => {
    const entry1 = logger.log({
      category: AuditCategory.DATA_MODIFICATION,
      action: 'tag.write',
      resourceType: 'tag',
      resourceId: 'tag1',
      userId: 'user-1',
      username: 'op1',
    });

    const entry2 = logger.log({
      category: AuditCategory.USER_ACTION,
      action: 'user.login',
      resourceType: 'user',
      resourceId: 'user-1',
      userId: 'user-1',
      username: 'op1',
    });

    expect(entry2.previousEntryHash).toBe(entry1.entryHash);
  });

  it('should verify chain integrity', () => {
    logger.log({ category: AuditCategory.DATA_MODIFICATION, action: 'a', resourceType: 't', resourceId: '1', userId: 'u', username: 'u' });
    logger.log({ category: AuditCategory.DATA_MODIFICATION, action: 'b', resourceType: 't', resourceId: '2', userId: 'u', username: 'u' });

    expect(logger.verifyChain().valid).toBe(true);
  });

  it('should query entries by category', () => {
    logger.log({ category: AuditCategory.DATA_MODIFICATION, action: 'a', resourceType: 't', resourceId: '1', userId: 'u', username: 'u' });
    logger.log({ category: AuditCategory.SECURITY_EVENT, action: 'b', resourceType: 't', resourceId: '2', userId: 'u', username: 'u' });

    const results = logger.query({ category: AuditCategory.SECURITY_EVENT });
    expect(results).toHaveLength(1);
    expect(results[0].action).toBe('b');
  });

  it('should add additional signatures', () => {
    const entry = logger.log({ category: AuditCategory.RECIPE_CHANGE, action: 'recipe.created', resourceType: 'recipe', resourceId: 'r1', userId: 'u1', username: 'author' });

    const sig = logger.addSignature(entry.id, { userId: 'u2', username: 'approver', fullName: 'Approver Name' }, 'Approved');
    expect(sig).toBeDefined();

    const entries = logger.query({ resourceId: 'r1' });
    expect(entries[0].signatures).toHaveLength(2);
  });
});

describe('Electronic Signatures', () => {
  const key = 'test-key';

  it('should create and verify signatures', () => {
    const entry = { id: 'e1', timestamp: '2026-01-01T00:00:00Z', action: 'test' };
    const signer = { userId: 'u1', username: 'user1', fullName: 'User One' };

    const sig = createElectronicSignature(entry, signer, 'Authored', key);
    expect(verifyElectronicSignature(entry, sig, key)).toBe(true);
    expect(verifyElectronicSignature(entry, sig, 'wrong-key')).toBe(false);
  });
});
