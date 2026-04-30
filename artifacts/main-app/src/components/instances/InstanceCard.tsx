import { useState, useEffect } from 'react';
import {
  Instance,
  AppUser,
  apiGetInstanceStatus,
  apiConnectInstance,
  apiDisconnectInstance,
  apiLogoutInstance,
  apiDeleteInstance,
  apiGetQrCode,
  apiListUsers,
  apiAssignInstanceOwner,
} from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

interface Props {
  instance: Instance;
  token: string;
  isAdmin?: boolean;
  onRefresh: () => void;
}

function statusColor(status: string) {
  switch (status) {
    case 'connected': return 'bg-green-500';
    case 'active': return 'bg-yellow-500';
    case 'creating': return 'bg-blue-500';
    case 'error': return 'bg-red-500';
    default: return 'bg-slate-400';
  }
}

function statusLabel(status: string) {
  switch (status) {
    case 'connected': return 'Conectado';
    case 'active': return 'Ativo';
    case 'creating': return 'Criando';
    case 'error': return 'Erro';
    default: return status || 'Desconhecido';
  }
}

export default function InstanceCard({ instance, token, isAdmin, onRefresh }: Props) {
  const [qrOpen, setQrOpen] = useState(false);
  const [qrData, setQrData] = useState<string | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [liveStatus, setLiveStatus] = useState(instance.status);

  /* — atribuir ao usuário — */
  const [users, setUsers] = useState<AppUser[]>([]);
  const [usersLoaded, setUsersLoaded] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string>(instance.created_by ?? '');
  const [assignLoading, setAssignLoading] = useState(false);
  const [assignMsg, setAssignMsg] = useState('');
  const [assignError, setAssignError] = useState('');

  useEffect(() => {
    if (isAdmin && !usersLoaded) {
      apiListUsers(token).then((res) => {
        if (res.success && Array.isArray(res.data)) {
          setUsers(res.data as AppUser[]);
          setUsersLoaded(true);
        }
      });
    }
  }, [isAdmin, token, usersLoaded]);

  async function checkStatus() {
    setActionLoading(true);
    try {
      const res = await apiGetInstanceStatus(token, instance.instance_name);
      if (res.success) {
        setLiveStatus(res.dbStatus || liveStatus);
      }
    } finally {
      setActionLoading(false);
    }
  }

  async function openQr() {
    setQrOpen(true);
    setQrLoading(true);
    setQrData(null);
    try {
      const res = await apiGetQrCode(token, instance.instance_name);
      if (res.success && res.data) {
        const d = res.data as Record<string, unknown>;
        const inner = (d.data as Record<string, unknown>) || d || {};
        const qr = String(inner.Qrcode || inner.qrcode || inner.base64 || '');
        setQrData(qr || null);
      }
    } finally {
      setQrLoading(false);
    }
  }

  async function handleConnect() {
    setActionLoading(true);
    try {
      await apiConnectInstance(token, instance.instance_name);
      onRefresh();
    } finally {
      setActionLoading(false);
    }
  }

  async function handleDisconnect() {
    setActionLoading(true);
    try {
      await apiDisconnectInstance(token, instance.instance_name);
      onRefresh();
    } finally {
      setActionLoading(false);
    }
  }

  async function handleLogout() {
    setActionLoading(true);
    try {
      await apiLogoutInstance(token, instance.instance_name);
      onRefresh();
    } finally {
      setActionLoading(false);
    }
  }

  async function handleDelete() {
    setActionLoading(true);
    try {
      await apiDeleteInstance(token, instance.instance_name);
      onRefresh();
    } finally {
      setActionLoading(false);
    }
  }

  async function handleAssign() {
    setAssignLoading(true);
    setAssignMsg('');
    setAssignError('');
    try {
      const res = await apiAssignInstanceOwner(
        token,
        instance.instance_name,
        selectedUserId || null,
      );
      if (res.success) {
        setAssignMsg('Atribuição salva com sucesso!');
        onRefresh();
      } else {
        setAssignError(res.error ?? 'Falha ao salvar atribuição.');
      }
    } catch {
      setAssignError('Erro de rede.');
    } finally {
      setAssignLoading(false);
    }
  }

  const isConnected = liveStatus === 'connected';

  return (
    <>
      <div className="bg-slate-800 border border-slate-700 rounded-lg p-4 flex flex-col gap-3">

        {/* Cabeçalho */}
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <span className={`inline-block w-2.5 h-2.5 rounded-full flex-shrink-0 ${statusColor(liveStatus)}`} />
            <span className="font-medium text-white truncate">{instance.instance_name}</span>
          </div>
          <Badge variant="outline" className="text-xs border-slate-600 text-slate-400 flex-shrink-0 ml-2">
            {statusLabel(liveStatus)}
          </Badge>
        </div>

        <p className="text-xs text-slate-500">
          Criado em {new Date(instance.created_at).toLocaleDateString('pt-BR')}
        </p>

        {/* Botões de ação */}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            className="border-slate-600 text-slate-300 hover:bg-slate-700 text-xs"
            onClick={checkStatus}
            disabled={actionLoading}
          >
            Status
          </Button>

          <Button
            size="sm"
            variant="outline"
            className="border-blue-700 text-blue-400 hover:bg-blue-900/30 text-xs"
            onClick={openQr}
            disabled={actionLoading}
          >
            QR Code
          </Button>

          {isConnected ? (
            <Button
              size="sm"
              variant="outline"
              className="border-yellow-700 text-yellow-400 hover:bg-yellow-900/30 text-xs"
              onClick={handleDisconnect}
              disabled={actionLoading}
            >
              Desconectar
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="border-green-700 text-green-400 hover:bg-green-900/30 text-xs"
              onClick={handleConnect}
              disabled={actionLoading}
            >
              Conectar
            </Button>
          )}

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className="border-orange-800 text-orange-400 hover:bg-orange-900/30 text-xs"
                disabled={actionLoading}
              >
                Logout
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent className="bg-slate-800 border-slate-700 text-white">
              <AlertDialogHeader>
                <AlertDialogTitle>Forçar logout?</AlertDialogTitle>
                <AlertDialogDescription className="text-slate-400">
                  O aparelho conectado a <strong>{instance.instance_name}</strong> será desconectado do WhatsApp.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel className="border-slate-600 text-slate-300 hover:bg-slate-700">Cancelar</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleLogout}
                  className="bg-orange-600 hover:bg-orange-700 text-white"
                >
                  Forçar Logout
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className="border-red-800 text-red-400 hover:bg-red-900/30 text-xs ml-auto"
                disabled={actionLoading}
              >
                Excluir
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent className="bg-slate-800 border-slate-700 text-white">
              <AlertDialogHeader>
                <AlertDialogTitle>Excluir instância?</AlertDialogTitle>
                <AlertDialogDescription className="text-slate-400">
                  A instância <strong>{instance.instance_name}</strong> será removida permanentemente.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel className="border-slate-600 text-slate-300 hover:bg-slate-700">Cancelar</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleDelete}
                  className="bg-red-600 hover:bg-red-700 text-white"
                >
                  Excluir
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>

        {/* ── Atribuir ao Usuário (admin only) ── */}
        {isAdmin && (
          <div className="border-t border-slate-700 pt-3 mt-1">
            <p className="text-xs text-purple-400 font-medium mb-2">👤 Atribuir ao Usuário</p>
            <div className="flex gap-2 items-center">
              <select
                value={selectedUserId}
                onChange={e => { setSelectedUserId(e.target.value); setAssignMsg(''); setAssignError(''); }}
                className="flex-1 h-8 rounded-md border border-slate-600 bg-slate-700 text-white px-2 text-xs focus:outline-none focus:border-purple-500"
              >
                <option value="">— Sem atribuição —</option>
                {users.map(u => (
                  <option key={u.id} value={u.id}>{u.name} ({u.email})</option>
                ))}
              </select>
              <Button
                size="sm"
                disabled={assignLoading}
                className="bg-purple-700 hover:bg-purple-600 text-white text-xs h-8 px-3 flex-shrink-0"
                onClick={handleAssign}
              >
                {assignLoading ? '...' : 'Salvar'}
              </Button>
            </div>
            {assignMsg && <p className="text-green-400 text-xs mt-1">{assignMsg}</p>}
            {assignError && <p className="text-red-400 text-xs mt-1">{assignError}</p>}
          </div>
        )}
      </div>

      {/* QR Code Dialog */}
      <Dialog open={qrOpen} onOpenChange={setQrOpen}>
        <DialogContent className="bg-slate-800 border-slate-700 text-white max-w-sm">
          <DialogHeader>
            <DialogTitle>QR Code — {instance.instance_name}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center gap-4 py-4">
            {qrLoading && <p className="text-slate-400 text-sm">Carregando QR Code...</p>}
            {!qrLoading && qrData && (
              <img
                src={qrData.startsWith('data:') ? qrData : `data:image/png;base64,${qrData}`}
                alt="QR Code WhatsApp"
                className="w-64 h-64 rounded-lg"
              />
            )}
            {!qrLoading && !qrData && (
              <p className="text-slate-400 text-sm text-center">
                QR Code indisponível. A instância pode já estar conectada ou o código ainda está sendo gerado.
              </p>
            )}
            <Button
              size="sm"
              variant="outline"
              className="border-slate-600 text-slate-300 hover:bg-slate-700"
              onClick={openQr}
              disabled={qrLoading}
            >
              Atualizar
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
