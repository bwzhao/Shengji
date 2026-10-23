/** 账号存储：注册校验、密码哈希、输错锁定、改名、管理员操作、存盘（GitHub issue #36）。 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Accounts, hashPassword, verifyPassword } from '../src/accounts.ts';

it('密码加盐哈希，同一个密码两次哈希不一样，都能验证', () => {
  const a = hashPassword('secret123');
  const b = hashPassword('secret123');
  expect(a).not.toBe(b);
  expect(a).not.toContain('secret123');
  expect(verifyPassword('secret123', a)).toBe(true);
  expect(verifyPassword('secret124', a)).toBe(false);
});

it('注册：登录名格式、登录名和显示名字不能重复（不分大小写），密码至少 6 位', () => {
  const acc = new Accounts(null);
  expect(acc.register('ab', 'secret123', '小赵').ok).toBe(false); // 太短
  expect(acc.register('小赵', 'secret123', '小赵').ok).toBe(false); // 登录名不能有中文
  expect(acc.register('zhao', '12345', '小赵').ok).toBe(false); // 密码太短
  const r = acc.register('Zhao_1', 'secret123', ' 小赵 ');
  expect(r.ok && r.account).toMatchObject({ username: 'zhao_1', displayName: '小赵' });
  expect(acc.register('ZHAO_1', 'secret123', '别人').ok).toBe(false);
  expect(acc.register('qian', 'secret123', '小赵').ok).toBe(false);
  expect(acc.nameTaken('小赵')).toBe(true);
  expect(acc.nameTaken('Alice')).toBe(false);
});

it('登录：用户名不分大小写；输错 5 次锁 1 分钟，锁过了能再登录', () => {
  const acc = new Accounts(null);
  acc.register('zhao', 'secret123', '小赵');
  expect(acc.login('ZHAO', 'secret123').ok).toBe(true);
  const t0 = Date.now();
  for (let i = 0; i < 5; i++) expect(acc.login('zhao', 'wrong', t0).ok).toBe(false);
  const locked = acc.login('zhao', 'secret123', t0 + 1000);
  expect(!locked.ok && locked.message).toContain('秒后再试');
  expect(acc.login('zhao', 'secret123', t0 + 61_000).ok).toBe(true);
  // 不存在的登录名和密码不对给一样的提示
  const a = acc.login('nobody', 'x');
  const b = acc.login('zhao', 'x');
  expect(!a.ok && a.message).toBe(!b.ok && b.message);
});

it('改显示名字不能和别人重复，可以只改大小写；改密码要原密码', () => {
  const acc = new Accounts(null);
  const zhao = (acc.register('zhao', 'secret123', '小赵') as { account: import('../src/accounts.ts').Account }).account;
  acc.register('qian', 'secret123', 'Qian');
  expect(acc.setDisplayName(zhao, 'qian')).toContain('已经有人用了');
  expect(acc.setDisplayName(zhao, '赵老师')).toBeNull();
  expect(acc.nameTaken('小赵')).toBe(false);
  expect(acc.changePassword(zhao, 'wrong', 'newpass1')).toContain('原密码不对');
  expect(acc.changePassword(zhao, 'secret123', 'newpass1')).toBeNull();
  expect(acc.login('zhao', 'newpass1').ok).toBe(true);
});

it('管理员：按配置的登录名认；重置密码给临时密码；停用后不能登录，恢复后可以', () => {
  const acc = new Accounts(null, ['Boss']);
  acc.register('boss', 'secret123', '老板');
  acc.register('zhao', 'secret123', '小赵');
  expect(acc.isAdmin(acc.find('boss')!)).toBe(true);
  expect(acc.isAdmin(acc.find('zhao')!)).toBe(false);
  const temp = acc.resetPassword('zhao')!;
  expect(temp).toMatch(/^[a-z2-9]{10}$/);
  expect(acc.login('zhao', 'secret123').ok).toBe(false);
  expect(acc.login('zhao', temp).ok).toBe(true);
  acc.setDisabled('zhao', true);
  const r = acc.login('zhao', temp);
  expect(!r.ok && r.message).toContain('停用');
  acc.setDisabled('zhao', false);
  expect(acc.login('zhao', temp).ok).toBe(true);
  expect(acc.list().map((x) => [x.username, x.isAdmin])).toEqual([['boss', true], ['zhao', false]]);
});

it('存进 accounts.json，重启后读回来；文件里没有明文密码', () => {
  const dir = mkdtempSync(join(tmpdir(), 'accounts-'));
  const a = new Accounts(dir);
  a.register('zhao', 'secret123', '小赵');
  expect(readFileSync(join(dir, 'accounts.json'), 'utf8')).not.toContain('secret123');
  const b = new Accounts(dir);
  expect(b.login('zhao', 'secret123').ok).toBe(true);
  expect(b.find('zhao')?.displayName).toBe('小赵');
});
