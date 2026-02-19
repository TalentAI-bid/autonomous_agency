'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiUpload } from '@/lib/api';
import type { Document, PaginatedResponse } from '@/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { UploadZone } from '@/components/documents/upload-zone';
import { formatDate } from '@/lib/utils';
import { FileText, Upload } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

export default function DocumentsPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [showUpload, setShowUpload] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);

  const { data: res, isLoading } = useQuery({
    queryKey: ['documents'],
    queryFn: () => apiGet<PaginatedResponse<Document>>('/documents'),
    staleTime: 30000,
  });

  const documents = (res?.data as unknown as Document[]) ?? [];

  async function handleUpload() {
    if (pendingFiles.length === 0) return;
    setUploading(true);
    let successCount = 0;
    for (const file of pendingFiles) {
      try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('type', 'general');
        await apiUpload('/documents', formData);
        successCount++;
      } catch {
        // continue
      }
    }
    setUploading(false);
    setPendingFiles([]);
    setShowUpload(false);
    qc.invalidateQueries({ queryKey: ['documents'] });
    toast({ title: `${successCount} of ${pendingFiles.length} documents uploaded` });
  }

  function docTypeVariant(type: string): 'default' | 'secondary' | 'outline' {
    if (type === 'job_spec' || type === 'spec') return 'default';
    if (type === 'cv') return 'outline';
    return 'secondary';
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Documents</h1>
          <p className="text-muted-foreground text-sm mt-1">Job specs, CVs, and other uploaded files</p>
        </div>
        <Button size="sm" onClick={() => setShowUpload((s) => !s)}>
          <Upload className="w-4 h-4 mr-2" />
          Upload
        </Button>
      </div>

      {showUpload && (
        <Card>
          <CardHeader><CardTitle className="text-sm font-medium">Upload Documents</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <UploadZone
              onFilesAdded={(files) => setPendingFiles((prev) => [...prev, ...files])}
              accept={{ 'application/pdf': ['.pdf'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'] }}
            />
            {pendingFiles.length > 0 && (
              <div className="space-y-2">
                {pendingFiles.map((f, i) => (
                  <div key={i} className="flex items-center justify-between p-2 rounded bg-muted/50 text-sm">
                    <span className="truncate">{f.name}</span>
                    <Button variant="ghost" size="sm" className="h-6 px-2 text-xs text-destructive" onClick={() => setPendingFiles((p) => p.filter((_, j) => j !== i))}>
                      Remove
                    </Button>
                  </div>
                ))}
                <Button size="sm" onClick={handleUpload} disabled={uploading} className="w-full">
                  {uploading ? 'Uploading...' : `Upload ${pendingFiles.length} file${pendingFiles.length > 1 ? 's' : ''}`}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20" />)}
        </div>
      ) : documents.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 gap-3">
            <div className="p-4 rounded-full bg-muted">
              <FileText className="w-8 h-8 text-muted-foreground" />
            </div>
            <div className="text-center">
              <h3 className="font-semibold">No documents yet</h3>
              <p className="text-sm text-muted-foreground mt-1">Upload job specs or CVs to train your agents</p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {documents.map((doc) => (
            <Card key={doc.id}>
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-muted shrink-0">
                    <FileText className="w-4 h-4 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{doc.fileName}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Uploaded {formatDate(doc.createdAt)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant={docTypeVariant(doc.type)}>{doc.type}</Badge>
                    <Badge variant={doc.status === 'processed' ? 'success' : 'secondary'}>{doc.status}</Badge>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
