import {expect,test} from "bun:test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {VerifiedTaskArtifacts} from "./metralla-m06-artifact-ui";
import {artifactDownloadPath,TASK_ARTIFACT_TTL_MS} from "./task-output-artifacts";
test("synthetic UI renders safe task route, hash and protected download, no internal links",()=>{
  const requestId="0000000000000001",artifactId="a".repeat(32),sha256="b".repeat(64),createdAt=1000,expiresAt=createdAt+TASK_ARTIFACT_TTL_MS;
  const artifact={schema:"opencode.task-output.v1",requestId,artifactId,sha256,createdAt,name:"report.txt",mime:"text/plain",byteSize:31,delivery:{kind:"authenticated-route",path:artifactDownloadPath(requestId,artifactId,expiresAt),expiresAt}};
  const text=renderToStaticMarkup(createElement(VerifiedTaskArtifacts,{content:[{type:"text",text:JSON.stringify(artifact)}]}));
  expect(text).toContain("Descargar archivo protegido");expect(text).toContain(sha256);expect(text).toContain("report.txt");expect(text).not.toContain("href=");
  const bad=renderToStaticMarkup(createElement(VerifiedTaskArtifacts,{content:[{type:"file",uri:"/bundle/report.txt",mime:"text/plain",name:"report.txt",artifact}]}));
  expect(bad).toBe("");
});
