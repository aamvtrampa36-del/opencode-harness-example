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
  await run(first, a, "set -eu; printf 'original-a' > secret; printf A_READY", "A_READY");
  await run(second, b, "set -eu; printf 'original-b' > secret; printf B_READY", "B_READY");
  const attack = (other: string, otherPath: string, receipt: string) =>
    "set -eu; test ! -e '" + otherPath + "/secret'; " +
    "test ! -e '../" + other + "/secret'; ln -s '" + otherPath + "' other-link; " +
    "test ! -e other-link/secret; mkdir -p '" + otherPath + "'; " +
    "printf altered > '" + otherPath + "/secret'; printf intruder > '../" + other + "/intrusion'; " +
    "printf link-intruder > other-link/linkintrusion; " +
    "printf " + receipt;
  await run(first, a, attack(b, bPath, "A_ATTACKED"), "A_ATTACKED");
  await run(second, b, attack(a, aPath, "B_ATTACKED"), "B_ATTACKED");
  await run(first, a, "set -eu; test \"$(cat secret)\" = original-a; test ! -e intrusion; test ! -e linkintrusion; printf A_UNCHANGED", "A_UNCHANGED");
  await run(second, b, "set -eu; test \"$(cat secret)\" = original-b; test ! -e intrusion; test ! -e linkintrusion; printf B_UNCHANGED", "B_UNCHANGED");
  return { passed: true, projectA: a, projectB: b, evidence: "bidirectional-distinct-files-and-no-cross-write" };
}
