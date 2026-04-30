import { useState, FormEvent } from 'react';
import { useAuthContext } from '@/context/AuthContext';
import { apiForgotPassword } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

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
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 to-slate-800 p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-green-500 mb-4">
            <svg className="w-8 h-8 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
              <path d="M12 0C5.373 0 0 5.373 0 12c0 2.136.563 4.14 1.542 5.877L.057 23.943 6.29 22.48A11.942 11.942 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.894a9.878 9.878 0 01-5.031-1.372l-.361-.214-3.741.981.998-3.648-.235-.374A9.857 9.857 0 012.106 12c0-5.458 4.436-9.894 9.894-9.894 5.458 0 9.894 4.436 9.894 9.894 0 5.458-4.436 9.894-9.894 9.894z"/>
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-white">PRE-Atendimento</h1>
          <p className="text-slate-400 text-sm mt-1">Gestão de instâncias WhatsApp</p>
        </div>

        <Card className="border-slate-700 bg-slate-800 text-white">
          <CardHeader className="pb-4">
            <CardTitle className="text-white text-lg">
              {mode === 'login' ? 'Entrar' : 'Recuperar senha'}
            </CardTitle>
            <CardDescription className="text-slate-400">
              {mode === 'login'
                ? 'Acesse o painel de controle'
                : 'Digite seu e-mail para receber o link'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {message ? (
              <div className="text-center">
                <p className="text-green-400 text-sm mb-4">{message}</p>
                <Button
                  variant="outline"
                  className="w-full border-slate-600 text-slate-300 hover:bg-slate-700"
                  onClick={() => { setMode('login'); setMessage(''); }}
                >
                  Voltar ao login
                </Button>
              </div>
            ) : (
              <form onSubmit={mode === 'login' ? handleLogin : handleForgot} className="space-y-4">
                <div className="space-y-1">
                  <Label className="text-slate-300">E-mail</Label>
                  <Input
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="seu@email.com"
                    required
                    className="bg-slate-700 border-slate-600 text-white placeholder:text-slate-500 focus:border-green-500"
                  />
                </div>
                {mode === 'login' && (
                  <div className="space-y-1">
                    <Label className="text-slate-300">Senha</Label>
                    <Input
                      type="password"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      placeholder="••••••••"
                      required
                      className="bg-slate-700 border-slate-600 text-white placeholder:text-slate-500 focus:border-green-500"
                    />
                  </div>
                )}
                {error && (
                  <p className="text-red-400 text-sm">{error}</p>
                )}
                <Button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-green-600 hover:bg-green-700 text-white"
                >
                  {loading ? 'Aguarde...' : mode === 'login' ? 'Entrar' : 'Enviar link'}
                </Button>
                {mode === 'login' ? (
                  <button
                    type="button"
                    onClick={() => { setMode('forgot'); setError(''); }}
                    className="w-full text-center text-sm text-slate-400 hover:text-slate-200 transition-colors"
                  >
                    Esqueci minha senha
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => { setMode('login'); setError(''); }}
                    className="w-full text-center text-sm text-slate-400 hover:text-slate-200 transition-colors"
                  >
                    Voltar ao login
                  </button>
                )}
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
