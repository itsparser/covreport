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
  // const pullRequestNumbers = core.getMultilineInput('pr-number');
  // if (pullRequestNumbers && pullRequestNumbers.length) {
  //     const prNumbers: number[] = [];

  //     for (const prNumber of pullRequestNumbers) {
  //     const prNumberInt = parseInt(prNumber, 10);
  //     if (isNaN(prNumberInt) || prNumberInt <= 0) {
  //         core.warning(`'${prNumber}' is not a valid pull request number`);
  //     } else {
  //         prNumbers.push(prNumberInt);
  //     }
  //     }

  //     return prNumbers;
  // }

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
  const config: TestConfig = {
    matchers: new Map(),
    commands: new Map(),
  };
  const givenMatchers = configObject["matchers"];
  const givenCommands = configObject["commands"];

  const matchers = config["matchers"];
  const commands = config["commands"];
  for (const label in givenMatchers) {
    if (givenMatchers[label] instanceof Array) {
      matchers.set(label, givenMatchers[label]);
    } else {
      throw Error(
        `found unexpected type for matchers ${label} (should be string or array of globs)`
      );
    }
  }
  for (const command in givenCommands) {
    if (typeof givenCommands[command] === "string") {
      commands.set(command, givenCommands[command]);
    } else {
      throw Error(
        `found unexpected type for commands ${command} (should be string or array of globs)`
      );
    }
  }

  return config;
}

async function getTestConfig(
  client: ClientType,
  configurationPath: string
): Promise<TestConfig> {
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

  // transform `any` => `TestConfig` or throw if yaml is malformed:
  return getConfig(configObject);
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

// equivalent to "Array.every()" but expanded for debugging and clarity
function checkAll(changedFiles: string[], globs: string[]): boolean {
  const matchers = globs.map((g) => new Minimatch(g));
  core.debug(` checking "all" patterns`);
  for (const changedFile of changedFiles) {
    if (!isMatch(changedFile, matchers)) {
      core.debug(`  "all" patterns did not match against ${changedFile}`);
      return false;
    }
  }
  core.debug(`  "all" patterns matched all files`);
  return true;
}

// equivalent to "Array.some()" but expanded for debugging and clarity
function checkAny(changedFiles: string[], globs: string[]): boolean {
  const matchers = globs.map((g) => new Minimatch(g));
  core.debug(`  checking "any" patterns`);
  for (const changedFile of changedFiles) {
    if (isMatch(changedFile, matchers)) {
      core.debug(`  "any" patterns matched against ${changedFile}`);
      return true;
    }
  }

  core.debug(`  "any" patterns did not match any files`);
  return false;
}

function checkMatch(changedFiles: string[], matchConfig: MatchConfig): boolean {
  if (matchConfig.all !== undefined) {
    if (!checkAll(changedFiles, matchConfig.all)) {
      return false;
    }
  }

  if (matchConfig.any !== undefined) {
    if (!checkAny(changedFiles, matchConfig.any)) {
      return false;
    }
  }

  return true;
}

export function checkPattern(
  changedFiles: string[],
  globs: MatchConfig[]
): boolean {
  for (const glob of globs) {
    core.debug(` checking pattern ${JSON.stringify(glob)}`);
    if (checkMatch(changedFiles, glob)) {
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

    const testConfigs: TestConfig = await getTestConfig(client, configPath);
    const matchers = testConfigs.matchers;
    const commands = testConfigs.commands;

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

      let commands: Set<string> = new Set();

      for (const [key, command] of commands.entries()) {
        core.debug(`check for patter for key ${key}`);
        const globs: MatchConfig[] = matchers[key];
        if (checkPattern(changedFiles, globs)) {
          commands.add(command);
        }
      }
      for (const command of commands) {
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
