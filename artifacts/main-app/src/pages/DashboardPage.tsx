import { useState, FormEvent } from 'react';
import { useLocation } from 'wouter';
import { useInstances, apiCreateInstance, Instance } from '@workspace/api-client-react';
import { useAuthContext } from '@/context/AuthContext';
import InstanceCard from '@/components/instances/InstanceCard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';

export default function DashboardPage() {
  const { user, token, logout } = useAuthContext();
  const { instances, loading, error, refresh } = useInstances(token);
  const [, navigate] = useLocation();
  const [search, setSearch] = useState('');

  const [createOpen, setCreateOpen] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState('');
  const [instanceName, setInstanceName] = useState('');
  const [evolutionUrl, setEvolutionUrl] = useState('');
  const [apiKey, setApiKey] = useState('');

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    setCreateError('');
    setCreateLoading(true);
    try {
      const res = await apiCreateInstance(token, {
        instanceName: instanceName.trim(),
        evolutionUrl: evolutionUrl.trim() || undefined,
        apiKey: apiKey.trim() || undefined,
      });
      if (res.success) {
        setCreateOpen(false);
        setInstanceName('');
        setEvolutionUrl('');
        setApiKey('');
        refresh();
      } else {
        setCreateError(res.error ?? 'Falha ao criar instância.');
      }
    } catch {
      setCreateError('Erro de rede.');
    } finally {
      setCreateLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <header className="bg-slate-800 border-b border-slate-700 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-green-500 flex items-center justify-center">
            <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
              <path d="M12 0C5.373 0 0 5.373 0 12c0 2.136.563 4.14 1.542 5.877L.057 23.943 6.29 22.48A11.942 11.942 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.894a9.878 9.878 0 01-5.031-1.372l-.361-.214-3.741.981.998-3.648-.235-.374A9.857 9.857 0 012.106 12c0-5.458 4.436-9.894 9.894-9.894 5.458 0 9.894 4.436 9.894 9.894s-4.436 9.894-9.894 9.894z"/>
            </svg>
          </div>
          <span className="font-semibold">PRE-Atendimento</span>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-sm text-slate-400 hidden sm:inline">
            {user?.name} <span className="text-slate-600">·</span>{' '}
            <span className="capitalize">{user?.role}</span>
          </span>
          {user?.role === 'admin' && (
            <Button
              size="sm"
              variant="outline"
              className="border-purple-700 text-purple-400 hover:bg-purple-900/20 text-xs"
              onClick={() => navigate('/admin')}
            >
              Admin
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="border-slate-600 text-slate-300 hover:bg-slate-700 text-xs"
            onClick={logout}
          >
            Sair
          </Button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-xl font-semibold">Instâncias WhatsApp</h2>
            <p className="text-sm text-slate-400 mt-0.5">
              {instances.length} {instances.length === 1 ? 'instância registrada' : 'instâncias registradas'}
            </p>
          </div>

          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button className="bg-green-600 hover:bg-green-700 text-white">
                + Nova instância
              </Button>
            </DialogTrigger>
            <DialogContent className="bg-slate-800 border-slate-700 text-white max-w-md">
              <DialogHeader>
                <DialogTitle>Criar nova instância</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleCreate} className="space-y-4 pt-2">
                <div className="space-y-1">
                  <Label className="text-slate-300">Nome da instância *</Label>
                  <Input
                    value={instanceName}
                    onChange={e => setInstanceName(e.target.value)}
                    placeholder="minha-instancia"
                    required
                    className="bg-slate-700 border-slate-600 text-white placeholder:text-slate-500 focus:border-green-500"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-slate-300">URL do Evolution</Label>
                  <Input
                    value={evolutionUrl}
                    onChange={e => setEvolutionUrl(e.target.value)}
                    placeholder="https://evolution.example.com"
                    className="bg-slate-700 border-slate-600 text-white placeholder:text-slate-500 focus:border-green-500"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-slate-300">API Key</Label>
                  <Input
                    value={apiKey}
                    onChange={e => setApiKey(e.target.value)}
                    placeholder="sua-api-key"
                    className="bg-slate-700 border-slate-600 text-white placeholder:text-slate-500 focus:border-green-500"
                  />
                </div>
                {createError && (
                  <p className="text-red-400 text-sm">{createError}</p>
                )}
                <div className="flex gap-2 pt-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1 border-slate-600 text-slate-300 hover:bg-slate-700"
                    onClick={() => setCreateOpen(false)}
                  >
                    Cancelar
                  </Button>
                  <Button
                    type="submit"
                    disabled={createLoading}
                    className="flex-1 bg-green-600 hover:bg-green-700 text-white"
                  >
                    {createLoading ? 'Criando...' : 'Criar'}
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        {/* Pesquisa */}
        {!loading && instances.length > 0 && (
          <div className="mb-4">
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="🔍 Pesquisar instâncias..."
              className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500 focus:border-green-500 max-w-sm"
            />
          </div>
        )}

        {loading && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3].map(i => (
              <div key={i} className="bg-slate-800 border border-slate-700 rounded-lg p-4 space-y-3">
                <Skeleton className="h-4 w-3/4 bg-slate-700" />
                <Skeleton className="h-3 w-1/2 bg-slate-700" />
                <div className="flex gap-2">
                  <Skeleton className="h-8 w-16 bg-slate-700" />
                  <Skeleton className="h-8 w-16 bg-slate-700" />
                  <Skeleton className="h-8 w-20 bg-slate-700" />
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading && error && (
          <div className="bg-red-900/30 border border-red-800 rounded-lg p-4 text-center">
            <p className="text-red-400">{error}</p>
            <Button
              size="sm"
              variant="outline"
              className="mt-3 border-red-700 text-red-400 hover:bg-red-900/30"
              onClick={refresh}
            >
              Tentar novamente
            </Button>
          </div>
        )}

        {!loading && !error && instances.length === 0 && (
          <div className="text-center py-16">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-slate-800 border border-slate-700 mb-4">
              <svg className="w-8 h-8 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V9m-9-6l6 6M9 3v6h6" />
              </svg>
            </div>
            <h3 className="text-slate-300 font-medium mb-1">Nenhuma instância ainda</h3>
            <p className="text-slate-500 text-sm mb-4">Crie sua primeira instância para começar</p>
            <Button
              className="bg-green-600 hover:bg-green-700 text-white"
              onClick={() => setCreateOpen(true)}
            >
              + Nova instância
            </Button>
          </div>
        )}

        {!loading && !error && instances.length > 0 && (() => {
          const filtered = instances.filter((i: Instance) =>
            i.instance_name.toLowerCase().includes(search.toLowerCase())
          );
          return (
            <>
              {filtered.length === 0 && (
                <p className="text-slate-500 text-sm text-center py-10">
                  Nenhuma instância corresponde à pesquisa.
                </p>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {filtered.map((inst: Instance) => (
                  <InstanceCard
                    key={inst.id}
                    instance={inst}
                    token={token!}
                    isAdmin={user?.role === 'admin'}
                    onRefresh={refresh}
                  />
                ))}
              </div>
            </>
          );
        })()}
      </main>
    </div>
  );
}
