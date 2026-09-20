export interface RegtestProject {
  project: string;
  publicKey: string;
  gatewayPort: string;
  rpcPort: string;
  ordPort: string;
  gatewayOrigin: string;
  rpcOrigin: string;
  ordOrigin: string;
}
export function selectRegtestProject(args: string[], environmentProject?: string): { project: string; args: string[] };
export function parseRegtestProject(text: string, project: string, publicKey: string): RegtestProject;
export function readRegtestProject(stateRoot: string, project: string): RegtestProject;
