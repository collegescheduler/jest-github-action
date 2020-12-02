import { sep, join, resolve } from "path"
import { readFileSync } from "fs"
import { exec } from "@actions/exec"
import * as core from "@actions/core"
import { GitHub, context } from "@actions/github"
import type { Octokit } from "@octokit/rest"
import flatMap from "lodash/flatMap"
import filter from "lodash/filter"
import map from "lodash/map"
import strip from "strip-ansi"
import table from "markdown-table"
import {
  createCoverageMap,
  CoverageMapData,
  createCoverageSummary,
} from "istanbul-lib-coverage"
import type { FormattedTestResults } from "@jest/test-result/build/types"

const ACTION_NAME = "jest-github-action"
const COVERAGE_HEADER = ":loop: **Code coverage**\n\n"

interface ActionError {
  error: string
  from: string
  message: string
  payload: string
}

interface GitHubFile {
  added: string
  modified: string
  removed: string
  renamed: string
  filename: string
  status: string
  previous_filename: string
  distinct: boolean
}

export async function run() {
  let workingDirectory = core.getInput("working-directory", { required: false })
  let cwd = workingDirectory ? resolve(workingDirectory) : process.cwd()
  const CWD = cwd + sep
  const RESULTS_FILE = join(CWD, "jest.results.json")

  try {
    const token = process.env.GITHUB_TOKEN
    if (token === undefined) {
      core.error("GITHUB_TOKEN not set.")
      core.setFailed("GITHUB_TOKEN not set.")
      return
    }

    const cmd = getJestCommand(RESULTS_FILE)

    await execJest(cmd, CWD)

    // octokit
    const octokit = new GitHub(token)

    // Parse results
    const results = parseResults(RESULTS_FILE)

    // Checks
    const checkPayload = getCheckPayload(results, CWD)
    await octokit.checks.create(checkPayload)

    // Coverage comments
    if (getPullId() && shouldCommentCoverage()) {
      const comment = await getCoverageTable(results, CWD, octokit)
      if (comment) {
        await deletePreviousComments(octokit)
        const commentPayload = getCommentPayload(comment)
        await octokit.issues.createComment(commentPayload)
      }
    }

    if (!results.success) {
      core.setFailed("Some jest tests failed.")
    }
  } catch (error) {
    console.error(error)
    core.setFailed(error.message)
  }
}

async function deletePreviousComments(octokit: GitHub) {
  const { data } = await octokit.issues.listComments({
    ...context.repo,
    per_page: 100,
    issue_number: getPullId(),
  })
  return Promise.all(
    data
      .filter(
        (c) =>
          c.user.login === "github-actions[bot]" && c.body.startsWith(COVERAGE_HEADER),
      )
      .map((c) => octokit.issues.deleteComment({ ...context.repo, comment_id: c.id })),
  )
}

function shouldCommentCoverage(): boolean {
  return Boolean(JSON.parse(core.getInput("coverage-comment", { required: false })))
}

function shouldRunOnlyChangedFiles(): boolean {
  return Boolean(JSON.parse(core.getInput("changes-only", { required: false })))
}

function shouldShowOnlyCoverageChangedFiles(): boolean {
  return Boolean(JSON.parse(core.getInput("coverage-changes-only", { required: false })))
}

export async function getCoverageTable(
  results: FormattedTestResults,
  cwd: string,
  octokit: GitHub,
): Promise<string | false> {
  if (!results.coverageMap) {
    return ""
  }
  const covMap = createCoverageMap((results.coverageMap as unknown) as CoverageMapData)
  const rows = [["Filename", "Statements", "Branches", "Functions", "Lines"]]

  if (!Object.keys(covMap.data).length) {
    console.error("No entries found in coverage data")
    return false
  }

  const allSummary = createCoverageSummary()

  // calculate the total coverage summary
  covMap.files().forEach(function (f) {
    const fc = covMap.fileCoverageFor(f)
    const fileSummary = fc.toSummary()
    allSummary.merge(fileSummary)
  })

  rows.push([
    "All files",
    allSummary.statements.pct + "%",
    allSummary.branches.pct + "%",
    allSummary.functions.pct + "%",
    allSummary.lines.pct + "%",
  ])

  let changedFiles: Array<GitHubFile> = []

  if (shouldShowOnlyCoverageChangedFiles()) {
    changedFiles = await getChangedPRFiles(octokit)
  }

  for (const [filename, data] of Object.entries(covMap.data || {})) {
    const { data: summary } = data.toSummary()
    const showAll = !shouldShowOnlyCoverageChangedFiles()
    const canonicalFilename = filename.replace(cwd, "")

    if (showAll || changedFiles.find((f) => f.filename === canonicalFilename))
      rows.push([
        canonicalFilename,
        summary.statements.pct + "%",
        summary.branches.pct + "%",
        summary.functions.pct + "%",
        summary.lines.pct + "%",
      ])
  }

  return COVERAGE_HEADER + table(rows, { align: ["l", "r", "r", "r", "r"] })
}

function getCommentPayload(body: string) {
  const payload: Octokit.IssuesCreateCommentParams = {
    ...context.repo,
    body,
    issue_number: getPullId(),
  }
  return payload
}

function getCheckPayload(results: FormattedTestResults, cwd: string) {
  const payload: Octokit.ChecksCreateParams = {
    ...context.repo,
    head_sha: getSha(),
    name: ACTION_NAME,
    status: "completed",
    conclusion: results.success ? "success" : "failure",
    output: {
      title: results.success ? "Jest tests passed" : "Jest tests failed",
      text: getOutputText(results),
      summary: results.success
        ? `${results.numPassedTests} tests passing in ${
            results.numPassedTestSuites
          } suite${results.numPassedTestSuites > 1 ? "s" : ""}.`
        : `Failed tests: ${results.numFailedTests}/${results.numTotalTests}. Failed suites: ${results.numFailedTests}/${results.numTotalTestSuites}.`,

      annotations: getAnnotations(results, cwd),
    },
  }
  console.debug("Check payload: %j", payload)
  return payload
}

function getJestCommand(resultsFile: string) {
  let cmd = core.getInput("test-command", { required: false })
  const jestOptions = `--testLocationInResults --json ${
    shouldCommentCoverage() ? "--coverage" : ""
  } ${
    shouldRunOnlyChangedFiles() && context.payload.pull_request?.base.ref
      ? "--changedSince=" + context.payload.pull_request?.base.ref
      : ""
  } --outputFile=${resultsFile}`
  const isNpm = cmd.startsWith("npm") || cmd.startsWith("npx")
  cmd += (isNpm ? " -- " : " ") + jestOptions
  core.debug("Final test command: " + cmd)
  return cmd
}

function parseResults(resultsFile: string): FormattedTestResults {
  const results = JSON.parse(readFileSync(resultsFile, "utf-8"))
  console.debug("Jest results: %j", results)
  return results
}

async function execJest(cmd: string, cwd?: string) {
  try {
    await exec(cmd, [], { silent: true, cwd })
    console.debug("Jest command executed")
  } catch (e) {
    console.error("Jest execution failed. Tests have likely failed.", e)
  }
}

function getPullId(): number {
  return context.payload.pull_request?.number ?? 0
}

function getSha(): string {
  return context.payload.pull_request?.head.sha ?? context.sha
}

const getAnnotations = (
  results: FormattedTestResults,
  cwd: string,
): Octokit.ChecksCreateParamsOutputAnnotations[] => {
  if (results.success) {
    return []
  }
  return flatMap(results.testResults, (result) => {
    return filter(result.assertionResults, ["status", "failed"]).map((assertion) => ({
      path: result.name.replace(cwd, ""),
      start_line: assertion.location?.line ?? 0,
      end_line: assertion.location?.line ?? 0,
      annotation_level: "failure",
      title: assertion.ancestorTitles.concat(assertion.title).join(" > "),
      message: strip(assertion.failureMessages?.join("\n\n") ?? ""),
    }))
  })
}

const getOutputText = (results: FormattedTestResults) => {
  if (results.success) {
    return
  }
  const entries = filter(map(results.testResults, (r) => strip(r.message)))
  return asMarkdownCode(entries.join("\n"))
}

export function asMarkdownCode(str: string) {
  return "```\n" + str.trimRight() + "\n```"
}

/**
 * @function getChangedPRFiles
 * @throws {Error} when a 404 or other is received.  404 can be bad repo, owner, pr, or unauthenticated
 * @param client authenticated github client (possibly un-authenticated if public)
 * @returns Promise of array of changed files
 * credit to: https://github.com/trilom/file-changes-action/blob/master/src/GithubHelper.ts
 */
async function getChangedPRFiles(octokit: GitHub): Promise<GitHubFile[]> {
  core.info("Fetching changed files")
  try {
    const options = octokit.pulls.listFiles.endpoint.merge({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: context.payload.pull_request?.number,
    })
    const files: GitHubFile[] = await octokit.paginate(
      options,
      (response) => response.data,
    )
    core.info("Changed files: " + JSON.stringify(files))

    return files
  } catch (error) {
    const eString = `There was an error getting change files for repo:${context.repo.repo} owner:${context.repo.owner} pr:${context.payload.pull_request?.number}`
    let ePayload: string
    if (error.name === "HttpError" && +error.status === 404)
      ePayload = getErrorString(
        error.name,
        error.status,
        getChangedPRFiles.name,
        eString,
        error,
      )
    else
      ePayload = getErrorString(
        `Unknown Error:${error.name || ""}`,
        error.status,
        getChangedPRFiles.name,
        eString,
        error.message,
      )
    throw new Error(ePayload)
  }
}

/**
 * @function getErrorString
 * @param name name of error
 * @param status status code of error
 * @param from name of function that error is thrown from
 * @param message error message
 * @param error error object to stringify and attach
 * credit to: https://github.com/trilom/file-changes-action/blob/master/src/UtilsHelper.ts#L11
 */
function getErrorString(
  name: string,
  status = 500,
  from: string,
  message: string,
  error: any = "",
): string {
  try {
    const test = JSON.stringify(
      {
        error: `${status}/${name}`,
        from,
        message,
        payload: error,
      } as ActionError,
      null,
      2,
    )
    return test
  } catch (error_) {
    core.setFailed(`Error throwing error.\n ${JSON.stringify(error_.message)}`)
    throw new Error(
      JSON.stringify({ name: "500/undefined", message: "Error throwing error." }),
    )
  }
}
