import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { z } from 'zod';

const loaderOptions: protoLoader.Options = {
  keepCase: false,
  longs: Number,
  enums: String,
  defaults: true,
  oneofs: true,
};

const ServiceCtorSchema = z.custom<GrpcServiceCtor>(value => {
  if (typeof value !== 'function') return false;
  const service = (value as { service?: unknown }).service;
  return typeof service === 'object' && service !== null;
});

const LoadedPackageSchema = z.object({
  xai: z.object({
    grok: z.object({
      tools: z.object({
        v1: z.object({
          GrokToolsService: ServiceCtorSchema,
        }),
      }),
    }),
  }),
});

export interface GrpcServiceCtor {
  service: grpc.ServiceDefinition;
  new (
    address: string,
    credentials: grpc.ChannelCredentials,
    options?: grpc.ClientOptions
  ): grpc.Client;
}

export function grokToolsProtoPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', 'proto', 'grok-tools.proto'),
    join(here, '..', '..', 'proto', 'grok-tools.proto'),
  ];
  const found = candidates.find(candidate => existsSync(candidate));
  if (!found) {
    throw new Error(`Could not find proto/grok-tools.proto from ${here}`);
  }
  return found;
}

export async function loadGrokToolsService(): Promise<GrpcServiceCtor> {
  const definition = await protoLoader.load(grokToolsProtoPath(), loaderOptions);
  const loaded = grpc.loadPackageDefinition(definition);
  const parsed = LoadedPackageSchema.safeParse(loaded);
  if (!parsed.success) {
    throw new Error('grok-tools.proto did not load xai.grok.tools.v1.GrokToolsService');
  }
  return parsed.data.xai.grok.tools.v1.GrokToolsService;
}

export const CHANNEL_OPTIONS: grpc.ChannelOptions = {
  'grpc.max_receive_message_length': 16 * 1024 * 1024,
  'grpc.max_send_message_length': 16 * 1024 * 1024,
};
