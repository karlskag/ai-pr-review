import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const AI_API_KEY: string = core.getInput("AI_API_KEY");
const AI_API_MODEL: string = core.getInput("AI_API_MODEL");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
	apiKey: AI_API_KEY,
});

interface PRDetails {
	owner: string;
	repo: string;
	pull_number: number;
	title: string;
	description: string;
}

async function getPRDetails(): Promise<PRDetails> {
	const { repository, number } = JSON.parse(
		readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
	);
	const prResponse = await octokit.pulls.get({
		owner: repository.owner.login,
		repo: repository.name,
		pull_number: number,
	});

	return {
		owner: repository.owner.login,
		repo: repository.name,
		pull_number: number,
		title: prResponse.data.title ?? "",
		description: prResponse.data.body ?? "",
	};
}

const defaultSystem = `Your task is to review pull requests. Instructions:
- Provide the response in following JSON format:  {"reviews": [{"path": <path_to_file>, "lineNumber":  <line_number>, "reviewComment": "<review comment>"}]}
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise "reviews" should be an empty array.
- Write the comment in GitHub Markdown format.
- Use the given description only for the overall context and only comment the code.
- IMPORTANT: NEVER suggest adding comments to the code.`;

async function getAIResponse<T extends Record<string, any>>(
	prompt: string,
	system: string = defaultSystem
): Promise<T | null> {
	core.info(`system: ${system}`);
	core.info(`prompt: ${prompt}`);
	const queryConfig = {
		model: AI_API_MODEL,
		temperature: 0.2,
		max_tokens: 700,
		top_p: 1,
		frequency_penalty: 0,
		presence_penalty: 0,
	};

	try {
		const response = await openai.chat.completions.create({
			...queryConfig,
			// return JSON if the model supports it:
			...(AI_API_MODEL === "gpt-4-1106-preview"
				? { response_format: { type: "json_object" } }
				: {}),
			messages: [
				{
					role: "system",
					content: system,
				},
				{
					role: "user",
					content: prompt,
				},
			],
		});

		const res = response.choices[0].message?.content?.trim() || "{}";
		core.info(`OpenAI response: ${res}`);
		return JSON.parse(res);
	} catch (error) {
		console.error("Error:", error);
		return null;
	}
}

async function getDiff(
	owner: string,
	repo: string,
	pull_number: number
): Promise<string | null> {
	const response = await octokit.pulls.get({
		owner,
		repo,
		pull_number,
		mediaType: { format: "diff" },
	});
	// @ts-expect-error - response.data is a string
	return response.data;
}

function mergeDiffs(files: File[]) {
	return files
		.map(
			(file) => `
path: ${file.to}
diff: ${file.chunks.map(
				(chunk) => `
\`\`\`diff
${chunk.content}
${chunk.changes
	// @ts-expect-error - ln and ln2 exists where needed
	.map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
	.join("\n")}
\`\`\`
`
			)}`
		)
		.join(`\n\n`);
}

function createComments(
	aiResponses: Array<{
		path: string | undefined;
		lineNumber: string;
		reviewComment: string;
	}>
) {
	return aiResponses.flatMap(({ path, reviewComment, lineNumber }) => {
		if (!path) {
			return [];
		}
		return {
			body: reviewComment,
			path: path,
			line: Number(lineNumber),
		};
	});
}

async function analyzeCode(
	files: File[],
	prDetails: PRDetails,
	system?: string
): Promise<Array<{ body: string; path: string; line: number }>> {
	const mergedDiffs = mergeDiffs(files);

	const aiResponse = await getAIResponse<{reviews: {
		path: string;
		lineNumber: string;
		reviewComment: string;
	}[]}>(
		`
Review the following code diffs and take the pull request title and description into account when writing the response.

Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

File diffs below:
${mergedDiffs}
`,
		system
	);

	if (!aiResponse) return [];

	const comments = createComments(aiResponse.reviews);
	core.info(`comments: ${comments}`);
	return comments;
}

async function createReviewComment(
	owner: string,
	repo: string,
	pull_number: number,
	comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
	await octokit.pulls.createReview({
		owner,
		repo,
		pull_number,
		comments,
		event: "COMMENT",
	});
}

async function aiReviewAction(prDetails: PRDetails, diff: parseDiff.File[]) {
	const comments = await analyzeCode(diff, prDetails);
	if (comments.length > 0) {
		await createReviewComment(
			prDetails.owner,
			prDetails.repo,
			prDetails.pull_number,
			comments
		);
	}
}

async function aiNamingAction(prDetails: PRDetails, diff: parseDiff.File[]) {
	const comments = await analyzeCode(
		diff,
		prDetails,
		`
Your task is to review pull requests. Instructions:
- Provide the response in following JSON format:  {"reviews": [{"path": <path_to_file>, "lineNumber":  <line_number>, "reviewComment": "<review comment>"}]}
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise "reviews" should be an empty array.
- Write the comment in GitHub Markdown format.
- Use the given description only for the overall context and only comment the code.
- Only give suggestions on naming of functions and variables
- a suggestion comment can be written with the following syntax:
\`\`\`suggestion
<new_code_suggestion>
\`\`\`
- IMPORTANT: NEVER suggest adding comments to the code.`
	);

	if (comments.length > 0) {
		await createReviewComment(
			prDetails.owner,
			prDetails.repo,
			prDetails.pull_number,
			comments
		);
	}
}

async function aiSummaryAction(prDetails: PRDetails, files: File[]) {
	const mergedDiffs = mergeDiffs(files);

	const aiResponse = await getAIResponse<{summary: string}>(
		`
Summarize the following code diffs and take the pull request title and description into account when writing the response.

Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

File diffs below:
${mergedDiffs}
`,
		`
Your task is to summarize changes in a pull requests. Instructions:
- Provide the full response in following JSON format:  {"summary": "<review comment>"}
- The response MUST be in a valid JSON format
- Write the summary in GitHub Markdown format and stringified for JSON
- It should be in bullet point format
- Include important code in the comment as a code block
- I'm looking for a detailed summary, highlighting key changes in the code, any new features, bug fixes, or major refactors.
- Additionally, include a section on recommended manual testing procedures. This should detail steps to validate that the new changes are working as expected, covering any new features or bug fixes introduced in this pull request.
- Finally, based on the changes you've summarized, offer a prediction on the outcome of the review process. Should this pull request be approved based on the changes made, or do the changes warrant further inspection by a human developer? Consider factors like the complexity of changes, potential impact on existing functionality, and adherence to project guidelines in your assessment.
`
	);
	core.info(`This is the summary: ${aiResponse}`);
	if (!aiResponse?.summary) {
		core.info("Nothing to summarize");
		return;
	} 
	
	await octokit.pulls.createReview({
		owner: prDetails.owner,
		repo: prDetails.repo,
		pull_number: prDetails.pull_number,
		body: aiResponse.summary,
		event: "COMMENT",
	});
}

async function getParsedDiff(
	prDetails: PRDetails,
	eventData: Record<string, any>
) {
	let diff: string | null;
	if (eventData.action === "opened" || eventData.action === "labeled") {
		diff = await getDiff(
			prDetails.owner,
			prDetails.repo,
			prDetails.pull_number
		);
	} else if (eventData.action === "synchronize") {
		const newBaseSha = eventData.before;
		const newHeadSha = eventData.after;

		const response = await octokit.repos.compareCommits({
			headers: {
				accept: "application/vnd.github.v3.diff",
			},
			owner: prDetails.owner,
			repo: prDetails.repo,
			base: newBaseSha,
			head: newHeadSha,
		});

		diff = String(response.data);
	} else {
		console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
		return;
	}

	if (!diff) {
		console.log("No diff found");
		return;
	}

	const parsedDiff = parseDiff(diff);

	const excludePatterns = core
		.getInput("exclude")
		.split(",")
		.map((s) => s.trim());

	return parsedDiff.filter((file) => {
		return !excludePatterns.some((pattern) =>
			minimatch(file.to ?? "", pattern)
		);
	});
}

async function main() {
	const prDetails = await getPRDetails();
	const eventData = JSON.parse(
		readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
	);

	const labels = eventData.pull_request.labels as { name: string }[];

	if (
		!labels.some((label) =>
			["ai-review", "ai-summary", "ai-naming"].includes(label.name)
		)
	) {
		core.info(`No supported label set`);
		return;
	}

	const parsedDiff = await getParsedDiff(prDetails, eventData);
	if (!parsedDiff) {
		core.info("No diff to review.");
		return;
	}

	for (const label of labels) {
		core.info(`Running action for label: ${label.name}`);
		switch (label.name) {
			case "ai-review": {
				await aiReviewAction(prDetails, parsedDiff);
				return;
			}
			case "ai-summary": {
				await aiSummaryAction(prDetails, parsedDiff);
				return;
			}
			case "ai-naming": {
				await aiNamingAction(prDetails, parsedDiff);
				return;
			}
			default: {
				core.info(`Unsupported label ${label.name}`);
				return;
			}
		}
	}
}

main().catch((error) => {
	console.error("Error:", error);
	process.exit(1);
});
