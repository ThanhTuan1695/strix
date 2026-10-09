import React, { useState, useEffect } from 'react';

export default function UserManagement({ token }) {
  const [users, setUsers] = useState([]);
  const [newUser, setNewUser] = useState({ username: '', password: '', role: 'user' });
  const [editingUser, setEditingUser] = useState(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const loadUsers = async () => {
    const res = await fetch('/api/auth/users', { headers });
    if (res.ok) setUsers(await res.json());
  };

  useEffect(() => { loadUsers(); }, []);

  const createUser = async (e) => {
    e.preventDefault();
    setError(''); setSuccess('');
    if (!newUser.username || !newUser.password) return setError('Username and password required');
    const res = await fetch('/api/auth/users', { method: 'POST', headers, body: JSON.stringify(newUser) });
    const data = await res.json();
    if (!res.ok) return setError(data.error);
    setSuccess(`User "${newUser.username}" created`);
    setNewUser({ username: '', password: '', role: 'user' });
    loadUsers();
  };

  const deleteUser = async (username) => {
    if (!confirm(`Delete user "${username}"?`)) return;
    const res = await fetch(`/api/auth/users/${username}`, { method: 'DELETE', headers });
    if (res.ok) { loadUsers(); setSuccess(`User "${username}" deleted`); }
    else { const d = await res.json(); setError(d.error); }
  };

  const updateUser = async (username) => {
    setError(''); setSuccess('');
    const body = {};
    if (editingUser.password) body.password = editingUser.password;
    if (editingUser.role) body.role = editingUser.role;
    const res = await fetch(`/api/auth/users/${username}`, { method: 'PUT', headers, body: JSON.stringify(body) });
    if (res.ok) { setEditingUser(null); setSuccess(`User "${username}" updated`); loadUsers(); }
    else { const d = await res.json(); setError(d.error); }
  };

  return (
    <div className="user-mgmt">
      <h3>User Management</h3>

      <form onSubmit={createUser} className="user-form">
        <input placeholder="Username" value={newUser.username}
          onChange={e => setNewUser(p => ({ ...p, username: e.target.value }))} />
        <input placeholder="Password" type="password" value={newUser.password}
          onChange={e => setNewUser(p => ({ ...p, password: e.target.value }))} />
        <select value={newUser.role} onChange={e => setNewUser(p => ({ ...p, role: e.target.value }))}>
          <option value="user">User</option>
          <option value="admin">Admin</option>
        </select>
        <button type="submit">Add User</button>
      </form>

      {error && <div className="login-error" style={{ marginTop: 8 }}>{error}</div>}
      {success && <div className="login-success" style={{ marginTop: 8 }}>{success}</div>}

      <table className="user-table">
        <thead>
          <tr><th>Username</th><th>Role</th><th>Created</th><th>Actions</th></tr>
        </thead>
        <tbody>
          {users.map(u => (
            <tr key={u.username}>
              <td>{u.username}</td>
              <td>
                {editingUser?.username === u.username ? (
                  <select value={editingUser.role || u.role}
                    onChange={e => setEditingUser(p => ({ ...p, role: e.target.value }))}>
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                  </select>
                ) : (
                  <span className={`role-badge role-${u.role}`}>{u.role}</span>
                )}
              </td>
              <td>{u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '-'}</td>
              <td>
                {editingUser?.username === u.username ? (
                  <>
                    <input placeholder="New password" type="password" style={{ width: 120 }}
                      value={editingUser.password || ''}
                      onChange={e => setEditingUser(p => ({ ...p, password: e.target.value }))} />
                    <button className="btn-sm" onClick={() => updateUser(u.username)}>Save</button>
                    <button className="btn-sm btn-ghost" onClick={() => setEditingUser(null)}>Cancel</button>
                  </>
                ) : (
                  <>
                    <button className="btn-sm" onClick={() => setEditingUser({ username: u.username, role: u.role, password: '' })}>Edit</button>
                    <button className="btn-sm btn-danger" onClick={() => deleteUser(u.username)}>Delete</button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
