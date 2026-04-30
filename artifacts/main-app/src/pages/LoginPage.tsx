import { useState, FormEvent } from 'react';
import { useAuthContext } from '@/context/AuthContext';
import { apiForgotPassword, apiRegister } from '@workspace/api-client-react';

type Mode = 'login' | 'register' | 'forgot';

export default function LoginPage() {
  const { login } = useAuthContext();
  const [mode, setMode] = useState<Mode>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  function switchMode(m: Mode) {
    setMode(m);
    setError('');
    setMessage('');
  }

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

  async function handleRegister(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await apiRegister(name, email, password);
      if (res.success) {
        setMessage('Conta criada! Aguarde a aprovação do administrador para acessar.');
      } else {
        setError(res.error ?? 'Erro ao criar conta.');
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
        <div className="bg-white rounded-2xl shadow-md overflow-hidden">

          {/* Tabs Entrar / Criar conta */}
          {mode !== 'forgot' && (
            <div className="flex border-b border-gray-100">
              <button
                type="button"
                onClick={() => switchMode('login')}
                className={`flex-1 py-3 text-sm font-semibold transition-colors ${
                  mode === 'login'
                    ? 'text-indigo-600 border-b-2 border-indigo-600'
                    : 'text-gray-400 hover:text-gray-600'
                }`}
              >
                Entrar
              </button>
              <button
                type="button"
                onClick={() => switchMode('register')}
                className={`flex-1 py-3 text-sm font-semibold transition-colors ${
                  mode === 'register'
                    ? 'text-indigo-600 border-b-2 border-indigo-600'
                    : 'text-gray-400 hover:text-gray-600'
                }`}
              >
                Criar conta
              </button>
            </div>
          )}

          <div className="p-8">
            {message ? (
              <div className="text-center">
                <p className="text-green-600 text-sm mb-4">{message}</p>
                <button
                  type="button"
                  onClick={() => switchMode('login')}
                  className="w-full text-center text-sm text-indigo-600 hover:text-indigo-800 transition-colors"
                >
                  Voltar ao login
                </button>
              </div>
            ) : mode === 'forgot' ? (
              <>
                <h2 className="text-xl font-bold text-gray-800 mb-1">Recuperar senha</h2>
                <p className="text-gray-500 text-sm mb-6">Digite seu e-mail para receber o link</p>

                <form onSubmit={handleForgot} className="space-y-4">
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

                  {error && <p className="text-red-500 text-sm">{error}</p>}

                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white font-semibold rounded-lg py-3 text-sm transition-colors"
                  >
                    {loading ? 'Aguarde...' : 'Enviar link'}
                  </button>

                  <button
                    type="button"
                    onClick={() => switchMode('login')}
                    className="w-full text-center text-sm text-indigo-600 hover:text-indigo-800 transition-colors"
                  >
                    Voltar ao login
                  </button>
                </form>
              </>
            ) : mode === 'login' ? (
              <>
                <h2 className="text-2xl font-bold text-gray-800 mb-1">Acesse sua conta</h2>
                <p className="text-gray-500 text-sm mb-6">Gerencie suas instâncias WhatsApp</p>

                <form onSubmit={handleLogin} className="space-y-4">
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

                  {error && <p className="text-red-500 text-sm">{error}</p>}

                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white font-semibold rounded-lg py-3 text-sm transition-colors"
                  >
                    {loading ? 'Aguarde...' : 'Entrar'}
                  </button>

                  <button
                    type="button"
                    onClick={() => switchMode('forgot')}
                    className="w-full text-center text-sm text-indigo-600 hover:text-indigo-800 transition-colors"
                  >
                    Esqueci minha senha
                  </button>
                </form>
              </>
            ) : (
              <>
                <h2 className="text-2xl font-bold text-gray-800 mb-1">Crie sua conta</h2>
                <p className="text-gray-500 text-sm mb-6">Preencha os dados para solicitar acesso</p>

                <form onSubmit={handleRegister} className="space-y-4">
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
                      NOME
                    </label>
                    <input
                      type="text"
                      value={name}
                      onChange={e => setName(e.target.value)}
                      placeholder="Seu nome"
                      required
                      className="w-full border border-gray-200 rounded-lg px-4 py-3 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent"
                    />
                  </div>

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
                      autoComplete="new-password"
                      className="w-full border border-gray-200 rounded-lg px-4 py-3 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent"
                    />
                  </div>

                  {error && <p className="text-red-500 text-sm">{error}</p>}

                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white font-semibold rounded-lg py-3 text-sm transition-colors"
                  >
                    {loading ? 'Aguarde...' : 'Criar conta'}
                  </button>
                </form>
              </>
            )}
          </div>
        </div>

        <p className="text-center text-xs text-gray-400 mt-4">🔒 Conexão segura e criptografada</p>
      </div>
    </div>
  );
}
