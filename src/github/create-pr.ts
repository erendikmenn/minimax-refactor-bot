export interface PullRequestRequest {
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  base: string;
}

export interface PullRequestResponse {
  url: string;
  number: number;
}

export class GitHubApiError extends Error {
  public readonly status: number;
  public readonly payload: string;

  public constructor(message: string, status: number, payload: string) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
    this.payload = payload;
  }
}

export class GitHubPullRequestCreator {
  private readonly token: string;

  public constructor(token: string) {
    this.token = token;
  }

  public async create(request: PullRequestRequest): Promise<PullRequestResponse> {
    const response = await fetch(`https://api.github.com/repos/${request.owner}/${request.repo}/pulls`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        title: request.title,
        body: request.body,
        head: request.head,
        base: request.base
      })
    });

    const text = await response.text();
    if (!response.ok) {
      throw new GitHubApiError(`Failed to create PR: ${response.status}`, response.status, text);
    }

    const parsed = JSON.parse(text) as { html_url: string; number: number };

    return {
      url: parsed.html_url,
      number: parsed.number
    };
  }
}
