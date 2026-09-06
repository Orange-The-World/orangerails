#!/usr/bin/env python3
"""Fail if any file in .github/workflows does not parse, or names a job in
needs that does not exist in the same file.

Run from the repository root:

    python3 scripts/validate-workflows.py

Exit status is 0 when every workflow file parsed and every needs reference
resolved, and 1 otherwise. It is also 1 when there was nothing to check,
because "I could not look" must never be reported as "everything is fine".
"""

import os
import sys

import yaml

WORKFLOW_DIR = os.path.join(".github", "workflows")
SUFFIXES = (".yml", ".yaml")


def annotate(path, message, line=None):
    """Emit one problem as a workflow command.

    Annotations are returned by the checks API; a job summary is not. Writing
    problems this way is what makes a red check readable without opening the
    raw log.
    """
    location = "file=" + path
    if line is not None:
        location += ",line=" + str(line)
    print("::error " + location + "::" + message.replace("\n", " "))


def check_file(path):
    """Return the number of problems found in one workflow file."""
    with open(path, "r", encoding="utf-8") as handle:
        text = handle.read()

    try:
        document = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        line = None
        mark = getattr(exc, "problem_mark", None)
        if mark is not None:
            line = mark.line + 1
        annotate(path, "does not parse as YAML: " + str(exc), line)
        return 1

    if not isinstance(document, dict):
        annotate(path, "parses, but the top level is not a mapping, so it is not a workflow")
        return 1

    jobs = document.get("jobs")
    if not isinstance(jobs, dict):
        annotate(path, "has no 'jobs:' mapping, so it defines no work")
        return 1

    problems = 0
    known = set(jobs)
    for job_id, job in jobs.items():
        if not isinstance(job, dict):
            annotate(path, "job '" + str(job_id) + "' is not a mapping")
            problems += 1
            continue

        needs = job.get("needs")
        if needs is None:
            continue
        if isinstance(needs, str):
            needs = [needs]
        if not isinstance(needs, list):
            annotate(path, "job '" + str(job_id) + "' has a 'needs' that is neither a job name nor a list of job names")
            problems += 1
            continue

        for dependency in needs:
            if dependency not in known:
                annotate(
                    path,
                    "job '" + str(job_id) + "' needs '" + str(dependency)
                    + "', which is not a job in this file",
                )
                problems += 1

    return problems


def main():
    if not os.path.isdir(WORKFLOW_DIR):
        print("::error::" + WORKFLOW_DIR + " does not exist, so nothing was validated")
        return 1

    names = sorted(
        name for name in os.listdir(WORKFLOW_DIR)
        if name.endswith(SUFFIXES)
        and os.path.isfile(os.path.join(WORKFLOW_DIR, name))
    )
    if not names:
        print("::error::no workflow files found under " + WORKFLOW_DIR
              + ", refusing to report success on an empty set")
        return 1

    problems = 0
    for name in names:
        problems += check_file(os.path.join(WORKFLOW_DIR, name))

    print("checked " + str(len(names)) + " workflow file(s) under "
          + WORKFLOW_DIR + ": " + str(problems) + " problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
