import { projectContainerName } from "./project-container";

type ProbeResult = { exitCode: number | null; stdout: string };
type ProbeContainer = { run(project: string, command: string): Promise<ProbeResult> };

/** Exercise two real containers with synthetic files; never touches personal. */
export async function checkIsolation(open: (name: string) => ProbeContainer, nonce: string) {
  if (!/^[a-f0-9]{12}$/.test(nonce)) throw Error("Invalid isolation probe identity");
  const a = "isocheck-a-" + nonce, b = "isocheck-b-" + nonce;
  const aPath = "/workspace/projects/" + a, bPath = "/workspace/projects/" + b;
  const first = open(projectContainerName(a)), second = open(projectContainerName(b));
  const run = async (container: ProbeContainer, project: string, command: string, receipt: string) => {
    const result = await container.run(project, command);
    if (result.exitCode !== 0 || result.stdout.trim() !== receipt) {
      throw Error("Isolation probe failed at " + receipt);
    }
  };
  await run(first, a, "set -eu; printf 'original' > secret; printf A_READY", "A_READY");
  await run(second, b,
    "set -eu; test ! -e '" + aPath + "/secret'; ln -s '" + aPath + "' other-link; " +
    "test ! -e other-link/secret; mkdir -p '" + aPath + "'; " +
    "printf altered > '" + aPath + "/secret'; printf intruder > '" + aPath + "/intrusion'; " +
    "printf own > secret; printf B_READY", "B_READY");
  await run(first, a,
    "set -eu; test \"$(cat secret)\" = original; test ! -e intrusion; " +
    "test ! -e '" + bPath + "/secret'; printf A_UNCHANGED", "A_UNCHANGED");
  await run(second, b,
    "set -eu; test \"$(cat secret)\" = own; test \"$(cat '" + aPath + "/secret')\" = altered; printf B_UNCHANGED",
    "B_UNCHANGED");
  return { passed: true, projectA: a, projectB: b, evidence: "distinct-files-and-no-cross-write" };
}
