export type Mime = 'image/jpeg' | 'image/png' | 'image/heic' | 'application/pdf' | 'application/json';

export type ManifestFile = {
  file_id: string;
  name: string;
  mime: Mime;
  size: number;
  sha256: string;
};

export type Manifest = {
  schema_version: 1;
  package_id: string;
  created_at: string;
  device_name: string;
  files: ManifestFile[];
};

export type ReceiptFile = ManifestFile & { status: 'stored' };

export type Receipt = {
  schema_version: 1;
  package_id: string;
  received_at: string;
  files: ReceiptFile[];
};

export type ReceivedPackage = { receipt: Receipt; deviceName: string };

export const MAX_FILE_BYTES = 52_428_800;
export const MAX_PACKAGE_BYTES = 524_288_000;
