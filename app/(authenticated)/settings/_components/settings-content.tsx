'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Settings,
  Key,
  Shield,
  Wifi,
  WifiOff,
  Save,
  TestTube2,
  Eye,
  EyeOff,
  CheckCircle2,
  XCircle,
  Loader2,
  FileKey,
  Info,
  BarChart3,
} from 'lucide-react';
import { toast } from 'sonner';
import { FadeIn } from '@/components/ui/animate';
import { ODDS_FORMAT_LABELS, ODDS_FORMAT_DESCRIPTIONS, type OddsFormat } from '@/lib/odds-format';

function OddsFormatCard() {
  const [oddsFormat, setOddsFormat] = useState<OddsFormat>('shares');
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch('/api/preferences')
      .then((r) => r?.json?.())
      .then((data) => {
        if (data?.oddsFormat) setOddsFormat(data.oddsFormat as OddsFormat);
      })
      .catch((err) => console.error('Prefs fetch error:', err))
      .finally(() => setLoaded(true));
  }, []);

  const handleChange = async (newFormat: string) => {
    const fmt = newFormat as OddsFormat;
    setOddsFormat(fmt);
    setSaving(true);
    try {
      await fetch('/api/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oddsFormat: fmt }),
      });
      toast.success(`Odds format changed to ${ODDS_FORMAT_LABELS[fmt]}`);
    } catch {
      toast.error('Failed to save preference');
    } finally {
      setSaving(false);
    }
  };

  const PREVIEW_EXAMPLES: Record<OddsFormat, string> = {
    shares: '45\u00a2 Yes / 55\u00a2 No',
    payout: '2.22x payout (45% probability)',
    american: '+122 / -180',
  };

  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-purple-500/10 flex items-center justify-center">
            <BarChart3 className="w-4.5 h-4.5 text-purple-400" />
          </div>
          <div>
            <CardTitle className="text-base font-display">Odds Display Format</CardTitle>
            <CardDescription>Choose how odds are displayed across the dashboard</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label className="text-sm">Display Format</Label>
          <Select value={oddsFormat} onValueChange={handleChange} disabled={saving}>
            <SelectTrigger className="h-10">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(ODDS_FORMAT_LABELS) as OddsFormat[]).map((fmt) => (
                <SelectItem key={fmt} value={fmt}>
                  <div className="flex flex-col">
                    <span>{ODDS_FORMAT_LABELS[fmt]}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">{ODDS_FORMAT_DESCRIPTIONS[oddsFormat]}</p>
        </div>

        {/* Live Preview */}
        <div className="p-3 rounded-lg bg-muted/30 border border-border/30">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1.5">Preview</p>
          <p className="text-sm font-mono">{PREVIEW_EXAMPLES[oddsFormat]}</p>
        </div>

        {/* Format descriptions */}
        <div className="space-y-2">
          {(Object.keys(ODDS_FORMAT_LABELS) as OddsFormat[]).map((fmt) => (
            <div key={fmt} className={`p-2 rounded-lg text-xs ${
              fmt === oddsFormat ? 'bg-primary/5 border border-primary/20' : 'text-muted-foreground'
            }`}>
              <span className="font-medium">{ODDS_FORMAT_LABELS[fmt]}:</span>{' '}
              {ODDS_FORMAT_DESCRIPTIONS[fmt]}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function SettingsContent() {
  const [config, setConfig] = useState<any>(null);
  const [keyId, setKeyId] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [environment, setEnvironment] = useState('production');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/config')
      .then((r: any) => r?.json?.())
      .then((data: any) => {
        setConfig(data);
        if (data?.environment) setEnvironment(data.environment);
      })
      .catch((err: any) => console.error('Config fetch error:', err))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    if (!keyId || !privateKey) {
      toast.error('Both Key ID and Private Key are required');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyId, privateKey, environment }),
      });
      const data = await res?.json?.();
      if (res?.ok) {
        toast.success('API credentials saved successfully');
        setKeyId('');
        setPrivateKey('');
        const configRes = await fetch('/api/config');
        const configData = await configRes?.json?.();
        setConfig(configData);
      } else {
        toast.error(data?.error ?? 'Failed to save credentials');
      }
    } catch (error: any) {
      console.error('Save error:', error);
      toast.error('Failed to save credentials');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      const res = await fetch('/api/config/test', { method: 'POST' });
      const data = await res?.json?.();
      if (data?.success) {
        toast.success(data?.message ?? 'Connection successful');
      } else {
        toast.error(data?.message ?? 'Connection failed');
      }
      const configRes = await fetch('/api/config');
      const configData = await configRes?.json?.();
      setConfig(configData);
    } catch (error: any) {
      console.error('Test error:', error);
      toast.error('Connection test failed');
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <FadeIn>
        <div>
          <h1 className="text-2xl font-display font-bold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground mt-1">Configure your Kalshi API credentials and preferences</p>
        </div>
      </FadeIn>

      {/* API Configuration */}
      <FadeIn delay={0.1}>
        <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-blue-500/10 flex items-center justify-center">
                <FileKey className="w-4.5 h-4.5 text-blue-400" />
              </div>
              <div>
                <CardTitle className="text-base font-display">Kalshi RSA Key Configuration</CardTitle>
                <CardDescription>Connect using your RSA private key from Kalshi</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Current Status */}
            {config?.configured && (
              <div className="flex items-center justify-between p-3 rounded-lg bg-muted/30">
                <div className="flex items-center gap-2">
                  {config?.isValid ? (
                    <><Wifi className="w-4 h-4 text-emerald-400" /><span className="text-sm font-medium text-emerald-400">Connected</span></>
                  ) : (
                    <><WifiOff className="w-4 h-4 text-red-400" /><span className="text-sm font-medium text-red-400">Not Verified</span></>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-[10px] font-mono">{config?.environment ?? 'demo'}</Badge>
                  <span className="text-[10px] font-mono text-muted-foreground">{config?.keyIdPreview ?? ''}</span>
                </div>
              </div>
            )}

            {/* How to get credentials */}
            <div className="p-3 rounded-lg bg-blue-500/5 border border-blue-500/20">
              <div className="flex items-start gap-2">
                <Info className="w-4 h-4 text-blue-400 mt-0.5 flex-shrink-0" />
                <div className="text-xs text-muted-foreground space-y-1">
                  <p className="font-medium text-blue-400">How to get your Kalshi API credentials:</p>
                  <ol className="list-decimal list-inside space-y-0.5">
                    <li>Log in to <a href="https://kalshi.com" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">kalshi.com</a></li>
                    <li>Go to <strong>Account Settings → API Keys</strong></li>
                    <li>Click <strong>"Generate New Key"</strong></li>
                    <li>Copy the <strong>Key ID</strong> (a unique identifier string)</li>
                    <li>Download or copy the <strong>Private Key</strong> (RSA PEM format)</li>
                  </ol>
                  <p className="text-amber-400/80 mt-1">⚠️ Save the private key immediately — Kalshi won't show it again!</p>
                </div>
              </div>
            </div>

            {/* Environment */}
            <div className="space-y-2">
              <Label className="text-sm">Environment</Label>
              <Select value={environment} onValueChange={setEnvironment}>
                <SelectTrigger className="h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="demo">Demo (Sandbox)</SelectItem>
                  <SelectItem value="production">Production (Live)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">Use demo for testing, production for live market data and trading</p>
            </div>

            {/* Key ID */}
            <div className="space-y-2">
              <Label className="text-sm">Key ID</Label>
              <Input
                type="text"
                placeholder="e.g., a1b2c3d4-e5f6-7890-abcd-ef1234567890"
                value={keyId}
                onChange={(e: any) => setKeyId(e?.target?.value ?? '')}
                className="font-mono text-sm"
              />
              <p className="text-[11px] text-muted-foreground">The unique identifier shown when you generate an API key on Kalshi</p>
            </div>

            {/* RSA Private Key */}
            <div className="space-y-2">
              <Label className="text-sm">RSA Private Key</Label>
              <div className="relative">
                <textarea
                  placeholder={`-----BEGIN RSA PRIVATE KEY-----\nPaste your entire private key here...\n-----END RSA PRIVATE KEY-----`}
                  value={privateKey}
                  onChange={(e: any) => setPrivateKey(e?.target?.value ?? '')}
                  rows={6}
                  className={`w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 resize-y min-h-[120px] ${
                    showKey ? '' : 'text-security-disc'
                  }`}
                  style={!showKey ? { WebkitTextSecurity: 'disc' } as any : {}}
                />
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-3 top-3 text-muted-foreground hover:text-foreground"
                >
                  {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Paste the full PEM content including the BEGIN/END lines. Supports both PKCS#1 and PKCS#8 formats.
              </p>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-3 pt-2">
              <Button onClick={handleSave} disabled={saving || !keyId || !privateKey} className="gap-2">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                Save Credentials
              </Button>
              {config?.configured && (
                <Button onClick={handleTest} variant="outline" disabled={testing} className="gap-2">
                  {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <TestTube2 className="w-4 h-4" />}
                  Test Connection
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </FadeIn>

      {/* Odds Format Settings */}
      <FadeIn delay={0.15}>
        <OddsFormatCard />
      </FadeIn>

      {/* Security Info */}
      <FadeIn delay={0.2}>
        <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-amber-500/10 flex items-center justify-center">
                <Shield className="w-4.5 h-4.5 text-amber-400" />
              </div>
              <div>
                <CardTitle className="text-base font-display">Security Notes</CardTitle>
                <CardDescription>Important information about your credentials</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li className="flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 flex-shrink-0" />
                <span>Your RSA private key is stored securely in the database and used only server-side for API signing</span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 flex-shrink-0" />
                <span>Requests are signed using RSA-PSS with SHA-256 — the private key is never sent over the network</span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 flex-shrink-0" />
                <span>Market data is fetched via public endpoints — no authentication needed for price data</span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 flex-shrink-0" />
                <span>No automated trades are placed — all bet placement is manual through Kalshi</span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 flex-shrink-0" />
                <span>Use demo environment first to verify everything works correctly</span>
              </li>
            </ul>
          </CardContent>
        </Card>
      </FadeIn>
    </div>
  );
}
