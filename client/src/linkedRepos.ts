// The repositories each project links (D-050), for the Coding agents pane and a card's brief (R-038).
import { useEffect, useState } from 'react';
import type { ProjectReposDTO } from '../../shared/types';
import { api } from './api';

/**
 * The repositories each project links (D-050), loaded when a view that needs them opens. A
 * deployment with no GitHub App links none, which `configured` says (R-038).
 */
export function useLinkedRepos(projectIds: number[]) {
  const [linked, setLinked] = useState<Record<number, Pick<ProjectReposDTO, 'configured'> & { repos: string[] }>>({});
  const key = projectIds.join();
  useEffect(() => {
    let live = true;
    for (const id of key.split(',').filter(Boolean).map(Number)) {
      api.projectRepos(id).then(
        (view) => live && setLinked((was) => ({ ...was, [id]: { configured: view.configured, repos: view.repos.map((r) => r.repo) } })),
        () => undefined,
      );
    }
    return () => {
      live = false;
    };
  }, [key]);
  return linked;
}
