import * as core from "@actions/core";
import * as github from "@actions/github";
import * as pluginRetry from "@octokit/plugin-retry";
import * as yaml from "js-yaml";
import fs from "fs";
import { Minimatch } from "minimatch";

type ClientType = ReturnType<typeof github.getOctokit>;

interface TestConfig {
  matchers: Map<string, MatchConfig[]>;
  commands: Map<string, string>;
}

interface CovReportConfig {
  matchers: any;
  commands: any;
}

interface MatchConfig {
  all?: string[];
  any?: string[];
}

type StringOrMatchConfig = string | MatchConfig;

/**
 * getPrNumbers - will Collect the PR for execution in the application
 * @return {Array<number>}
 */
function getPrNumbers(): number[] {
    const pullRequestNumbers = core.getMultilineInput('pr-number');
    if (pullRequestNumbers && pullRequestNumbers.length) {
        const prNumbers: number[] = [];

        for (const prNumber of pullRequestNumbers) {
        const prNumberInt = parseInt(prNumber, 10);
        if (isNaN(prNumberInt) || prNumberInt <= 0) {
            core.warning(`'${prNumber}' is not a valid pull request number`);
        } else {
            prNumbers.push(prNumberInt);
        }
        }

        return prNumbers;
    }

  const pullRequest = github.context.payload.pull_request;
  if (!pullRequest) {
    return [];
  }

  return [pullRequest.number];
}

async function getChangedFiles(
  client: ClientType,
  prNumber: number
): Promise<string[]> {
  const listFilesOptions = client.rest.pulls.listFiles.endpoint.merge({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    pull_number: prNumber,
  });

  const listFilesResponse = await client.paginate(listFilesOptions);
  const changedFiles = listFilesResponse.map((f: any) => f.filename);

  core.debug("found changed files:");
  for (const file of changedFiles) {
    core.debug("  " + file);
  }
  return changedFiles;
}

/**
 * fetchContent - will fetch the file from the github repository
 * @param client - Client Type object from the octakit
 * @param repoPath - Repository path from where the file can be accessiable
 * @return {Promise<string>}
 */
async function fetchContent(
  client: ClientType,
  repoPath: string
): Promise<string> {
  const response: any = await client.rest.repos.getContent({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    path: repoPath,
    ref: github.context.sha,
  });

  return Buffer.from(response.data.content, response.data.encoding).toString();
}

function getConfig(configObject: any): TestConfig {
  const config: CovReportConfig = configObject;

  return config;
}

/**
 * getCovReportConfig - Get the Configuration for
 * @param client - Client Type object from the octakit
 * @param configurationPath - Repository path from where the file can be accessiable
 * @return {Promise<CovReportConfig>}
 */
async function getTestConfig(
  client: ClientType,
  configurationPath: string
): Promise<CovReportConfig> {
  let configurationContent: string;
  try {
    if (!fs.existsSync(configurationPath)) {
      core.info(
        `The configuration file (path: ${configurationPath}) was not found locally, fetching via the api`
      );
      configurationContent = await fetchContent(client, configurationPath);
    } else {
      core.info(
        `The configuration file (path: ${configurationPath}) was found locally, reading from the file`
      );
      configurationContent = fs.readFileSync(configurationPath, {
        encoding: "utf8",
      });
    }
  } catch (e: any) {
    if (e.name == "HttpError" || e.name == "NotFound") {
      core.warning(
        `The config file was not found at ${configurationPath}. Make sure it exists and that this action has the correct access rights.`
      );
    }
    throw e;
  }

  // loads (hopefully) a `{[label:string]: string | StringOrMatchConfig[]}`, but is `any`:
  const configObject: any = yaml.load(configurationContent);

  const tconfigObject: CovReportConfig = configObject;
  return tconfigObject;
}

function printPattern(matcher: Minimatch): string {
  return (matcher.negate ? "!" : "") + matcher.pattern;
}

function isMatch(changedFile: string, matchers: Minimatch[]): boolean {
  core.debug(`    matching patterns against file ${changedFile}`);
  for (const matcher of matchers) {
    core.debug(`   - ${printPattern(matcher)}`);
    if (!matcher.match(changedFile)) {
      core.debug(`   ${printPattern(matcher)} did not match`);
      return false;
    }
  }

  core.debug(`   all patterns matched`);
  return true;
}

function checkMatch(changedFiles: string[], matchConfig: MatchConfig): boolean {
  if (matchConfig.all !== undefined) {
    const allMatcher = matchConfig.all.map((config) => new Minimatch(config));
    const result = allMatcher.every((matcher) =>
      changedFiles.some((file) => matcher.match(file))
    );
    core.info(`Result for the Match [All] ${result}`);
    return result;
  }

  if (matchConfig.any !== undefined) {
    const anyMatcher = matchConfig.any.map((config) => new Minimatch(config));
    const result = anyMatcher.some((matcher) =>
      changedFiles.some((file) => matcher.match(file))
    );
    core.info(`Result for the Match [Any] ${result}`);
    return result;
  }

  return true;
}

export function checkPattern(
  changedFiles: string[],
  configs: MatchConfig[]
): boolean {
  for (const config of configs) {
    core.info(` checking pattern ${JSON.stringify(config)}`);
    if (checkMatch(changedFiles, config)) {
      return true;
    }
  }
  return false;
}

/// Run the test converage Based on the given input for the application
export async function run() {
  try {
    const token = core.getInput("repo-token");
    const configPath = core.getInput("configuration-path", { required: true });
    const prNumbers = getPrNumbers();
    if (!prNumbers.length) {
      core.warning("Could not get pull request number(s), exiting");
      return;
    }

    const client: ClientType = github.getOctokit(token, {}); // , pluginRetry.retry

    const testConfigs: CovReportConfig = await getTestConfig(
      client,
      configPath
    );

    const matchers = testConfigs.matchers;

    for (const prNumber of prNumbers) {
      core.debug(`looking for pr #${prNumber}`);
      let pullRequest: any;
      try {
        const result = await client.rest.pulls.get({
          owner: github.context.repo.owner,
          repo: github.context.repo.repo,
          pull_number: prNumber,
        });
        pullRequest = result.data;
      } catch (error: any) {
        core.warning(`Could not find pull request #${prNumber}, skipping`);
        continue;
      }
      core.debug(`fetching changed files for pr #${prNumber}`);
      const changedFiles: string[] = await getChangedFiles(client, prNumber);
      if (!changedFiles.length) {
        core.warning(
          `Pull request #${prNumber} has no changed files, skipping`
        );
        continue;
      }

      let exeCommands: Set<string> = new Set();
      const commands: any = testConfigs.commands;

      for (const key in commands) {
        const command: string = commands[key];
        const matcherConfig: MatchConfig[] = matchers[key];
        core.info(` checking pattern ${key}`);
        if (checkPattern(changedFiles, matcherConfig)) {
          exeCommands.add(command);
        }
      }
      for (const command of exeCommands) {
        core.warning(
          `Command List for which the test case will get executed from the Application #${command} has no changed files, skipping`
        );
      }
    }
  } catch (error: any) {
    core.error(error);
    core.setFailed(error.message);
  }
}
