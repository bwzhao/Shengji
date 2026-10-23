/** 账号：登录、注册、账号设置（改显示名字、改密码、退出登录）、管理员管理账号。 */
import { useEffect, useState } from 'react';
import type { GameClient } from '../ws.ts';
import { Sheet } from './InfoSheets.tsx';

export type AccountSheetMode = 'login' | 'register' | 'settings' | 'admin';

export function AccountSheet({ client, mode, onMode, onClose }: {
  client: GameClient; mode: AccountSheetMode; onMode: (m: AccountSheetMode) => void; onClose: () => void;
}) {
  // 登录或注册成功后自动关上
  const loggedIn = Boolean(client.account);
  useEffect(() => {
    if (loggedIn && (mode === 'login' || mode === 'register')) onClose();
  }, [loggedIn]);

  const title = { login: '登录', register: '注册账号', settings: '账号设置', admin: '管理账号' }[mode];
  return (
    <Sheet title={title} onClose={onClose}>
      {mode === 'login' && <LoginForm client={client} onRegister={() => onMode('register')} />}
      {mode === 'register' && <RegisterForm client={client} onLogin={() => onMode('login')} />}
      {mode === 'settings' && <SettingsForm client={client} />}
      {mode === 'admin' && <AdminPanel client={client} />}
    </Sheet>
  );
}

function LoginForm({ client, onRegister }: { client: GameClient; onRegister: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    client.send({ t: 'login', username, password });
  };
  return (
    <form className="account-form" onSubmit={submit}>
      <label className="field"><span>登录名</span><input value={username} autoComplete="username" onChange={(e) => setUsername(e.target.value)} /></label>
      <label className="field"><span>密码</span><input type="password" value={password} autoComplete="current-password" onChange={(e) => setPassword(e.target.value)} /></label>
      <button className="primary" type="submit" disabled={!username.trim() || !password}>登录</button>
      <div className="hint">还没有账号？<button type="button" className="link" onClick={onRegister}>注册一个</button>。忘了密码请找管理员重置。</div>
    </form>
  );
}

function RegisterForm({ client, onLogin }: { client: GameClient; onLogin: () => void }) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState(client.name);
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const mismatch = again.length > 0 && again !== password;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    client.send({ t: 'register', username, password, displayName });
  };
  return (
    <form className="account-form" onSubmit={submit}>
      <label className="field"><span>登录名（3 到 20 位字母、数字、下划线，只用来登录）</span><input value={username} autoComplete="username" onChange={(e) => setUsername(e.target.value)} /></label>
      <label className="field"><span>显示名字（牌桌上大家看到的，之后可以改）</span><input value={displayName} maxLength={12} onChange={(e) => setDisplayName(e.target.value)} /></label>
      <label className="field"><span>密码（至少 6 位）</span><input type="password" value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} /></label>
      <label className="field"><span>再输一遍密码</span><input type="password" value={again} autoComplete="new-password" onChange={(e) => setAgain(e.target.value)} /></label>
      {mismatch && <div className="hint warn">两次密码不一样</div>}
      <button className="primary" type="submit" disabled={!username.trim() || !displayName.trim() || password.length < 6 || again !== password}>注册并登录</button>
      <div className="hint">注册后换设备、清浏览器也还是你，座位跟着账号走；你的显示名字别人不能再用。已有账号？<button type="button" className="link" onClick={onLogin}>去登录</button></div>
    </form>
  );
}

function SettingsForm({ client }: { client: GameClient }) {
  const account = client.account;
  const [displayName, setDisplayName] = useState(account?.displayName ?? '');
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  useEffect(() => { setDisplayName(account?.displayName ?? ''); }, [account?.displayName]);
  if (!account) return <div className="hint">已经退出登录</div>;
  return (
    <div className="account-form">
      <div className="hint">登录名 <b>{account.username}</b>（不能改）</div>
      <form className="account-row" onSubmit={(e) => { e.preventDefault(); client.send({ t: 'setDisplayName', displayName }); }}>
        <label className="field"><span>显示名字</span><input value={displayName} maxLength={12} onChange={(e) => setDisplayName(e.target.value)} /></label>
        <button className="primary" type="submit" disabled={!displayName.trim() || displayName.trim() === account.displayName}>保存</button>
      </form>
      <form className="account-form" onSubmit={(e) => { e.preventDefault(); client.send({ t: 'changePassword', oldPassword, newPassword }); setOldPassword(''); setNewPassword(''); }}>
        <label className="field"><span>原密码</span><input type="password" value={oldPassword} autoComplete="current-password" onChange={(e) => setOldPassword(e.target.value)} /></label>
        <label className="field"><span>新密码（至少 6 位）</span><input type="password" value={newPassword} autoComplete="new-password" onChange={(e) => setNewPassword(e.target.value)} /></label>
        <button className="ghost" type="submit" disabled={!oldPassword || newPassword.length < 6}>修改密码</button>
      </form>
      <button className="ghost danger" onClick={() => client.send({ t: 'logout' })}>退出登录</button>
    </div>
  );
}

function AdminPanel({ client }: { client: GameClient }) {
  useEffect(() => { client.send({ t: 'adminListAccounts' }); }, []);
  const rows = client.adminAccounts;
  const fmt = (t: number | null) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
  return (
    <div className="account-form">
      {client.tempPassword && (
        <div className="temp-password">
          <span><b>{client.tempPassword.username}</b> 的临时密码：</span>
          <code>{client.tempPassword.password}</code>
          <span className="hint">只显示这一次，告诉本人登录后自己改掉。</span>
          <button className="ghost small" onClick={client.clearTempPassword}>知道了</button>
        </div>
      )}
      {rows === null && <div className="hint">加载中…</div>}
      {rows?.length === 0 && <div className="hint">还没有人注册</div>}
      {rows && rows.length > 0 && (
        <table className="admin-table">
          <thead><tr><th>登录名</th><th>显示名字</th><th>注册</th><th>最近登录</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.username} className={r.disabled ? 'disabled' : ''}>
                <td>{r.username}{r.isAdmin && <span className="tag">管理员</span>}{r.disabled && <span className="tag">已停用</span>}</td>
                <td>{r.displayName}</td>
                <td>{fmt(r.createdAt)}</td>
                <td>{fmt(r.lastLoginAt)}</td>
                <td>
                  <div className="admin-actions">
                    <button className="ghost small" onClick={() => { if (confirm(`把 ${r.username} 的密码重置成一个临时密码？`)) client.send({ t: 'adminResetPassword', username: r.username }); }}>重置密码</button>
                    {r.username !== client.account?.username && (
                      <button className={`ghost small ${r.disabled ? '' : 'danger'}`} onClick={() => {
                        if (r.disabled || confirm(`停用 ${r.username}？对方会被登出，之后不能再登录，座位留着显示离线。`)) client.send({ t: 'adminSetDisabled', username: r.username, disabled: !r.disabled });
                      }}>{r.disabled ? '恢复' : '停用'}</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
