import type { EasyGitAction, EasyGitRequest, EasyGitResponse } from '../shared/contracts'

export function rpc<A extends EasyGitAction>(body: EasyGitRequest<A>, signal?: AbortSignal): Promise<EasyGitResponse<A>> {
  // DSH's document base preserves reverse-proxy prefixes as well as root deployments.
  return fetch('easygit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  }).then(response => response.json() as Promise<EasyGitResponse<A>>)
}
