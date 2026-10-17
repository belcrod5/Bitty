const fs = require("node:fs");
const path = require("node:path");
const { IOSConfig, withXcodeProject } = require("expo/config-plugins");

module.exports = (config) => withXcodeProject(config, (next) => {
  const project = next.modResults;
  const { projectRoot, platformProjectRoot } = next.modRequest;
  const target = project.getFirstTarget();
  const groupName = "BittyVoiceIntent";
  const fileName = "BittyVoiceIntent.swift";
  const destination = path.join(platformProjectRoot, groupName);
  fs.mkdirSync(destination, { recursive: true });
  fs.copyFileSync(path.join(projectRoot, "siri", fileName), path.join(destination, fileName));
  IOSConfig.XcodeUtils.ensureGroupRecursively(project, groupName);
  IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
    project, targetUuid: target.uuid, groupName, filepath: `${groupName}/${fileName}`,
  });
  return next;
});
