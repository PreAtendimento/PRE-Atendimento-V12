import { useState, FormEvent } from 'react';
import { useAuthContext } from '@/context/AuthContext';
import { apiForgotPassword } from '@workspace/api-client-react';

type Mode = 'login' | 'forgot';

export default function LoginPage() {
  const { login } = useAuthContext();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await login(email, password);
      if (!res.success) {
        setError(res.error ?? 'Falha no login.');
      }
    } catch {
      setError('Erro de rede. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  async function handleForgot(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await apiForgotPassword(email);
      if (res.success) {
        setMessage('Se esse e-mail estiver cadastrado, você receberá um link de redefinição.');
      } else {
        setError(res.error ?? 'Erro ao enviar e-mail.');
      }
    } catch {
      setError('Erro de rede. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-sm">

        {/* Logo oficial */}
        <div className="text-center mb-6">
          <img
            src="https://pre-atendimento.replit.app/logo-pre-atendimento.png"
            alt="Pré-Atendimento"
            className="h-20 mx-auto mb-2 object-contain"
          />
          <p className="text-gray-500 text-sm">Painel WhatsApp - v8</p>
        </div>

        {/* Card branco */}
        <div className="bg-white rounded-2xl shadow-md p-8">

          {message ? (
            <div className="text-center">
              <p className="text-green-600 text-sm mb-4">{message}</p>
              <button
                type="button"
                onClick={() => { setMode('login'); setMessage(''); }}
                className="w-full text-center text-sm text-indigo-600 hover:text-indigo-800 transition-colors"
              >
                Voltar ao login
              </button>
            </div>
          ) : (
            <>
              <h2 className="text-2xl font-bold text-gray-800 mb-1">
                {mode === 'login' ? 'Acesse sua conta' : 'Recuperar senha'}
              </h2>
              <p className="text-gray-500 text-sm mb-6">
                {mode === 'login'
                  ? 'Gerencie suas instâncias WhatsApp'
                  : 'Digite seu e-mail para receber o link'}
              </p>

              <form onSubmit={mode === 'login' ? handleLogin : handleForgot} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
                    E-MAIL
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="seu@email.com"
                    required
                    className="w-full border border-gray-200 rounded-lg px-4 py-3 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent"
                  />
                </div>

                {mode === 'login' && (
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
                      SENHA
                    </label>
                    <input
                      type="password"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      placeholder="••••••••"
                      required
                      autoComplete="current-password"
                      className="w-full border border-gray-200 rounded-lg px-4 py-3 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent"
                    />
                  </div>
                )}

                {error && (
                  <p className="text-red-500 text-sm">{error}</p>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white font-semibold rounded-lg py-3 text-sm transition-colors"
                >
                  {loading ? 'Aguarde...' : mode === 'login' ? 'Entrar' : 'Enviar link'}
                </button>

                {mode === 'login' ? (
                  <button
                    type="button"
                    onClick={() => { setMode('forgot'); setError(''); }}
                    className="w-full text-center text-sm text-indigo-600 hover:text-indigo-800 transition-colors"
                  >
                    Esqueci minha senha
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => { setMode('login'); setError(''); }}
                    className="w-full text-center text-sm text-indigo-600 hover:text-indigo-800 transition-colors"
                  >
                    Voltar ao login
                  </button>
                )}
              </form>
            </>
          )}
        </div>

        <p className="text-center text-xs text-gray-400 mt-4">🔒 Conexão segura e criptografada</p>
      </div>
    </div>
  );
}
