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
import re
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


# OR-T2789. A job with no `if` carries an implicit success(), and success() also
# looks at SKIPPED ancestors. supabase-deploy.yml skips apply-migrations on every
# prod push by design, so a deploy job without its own `if` was skipped on every
# prod push even with all of its direct needs green. The job below must therefore
# carry an explicit `if` that (a) has a status function, which replaces the
# implicit success(), and (b) names EVERY need as exactly 'success', so a failed,
# cancelled or skipped gate still skips it. '!= failure' is refused on purpose:
# it lets a skipped gate through.
DEPLOY_GATE_FILE = "supabase-deploy.yml"
DEPLOY_GATE_JOB = "deploy"


def deploy_gate_problems(needs, condition):
    """Return the reasons this needs list and if-expression are unsafe.

    An empty list means the gate is acceptable.
    """
    problems = []
    if not isinstance(condition, str) or not condition.strip():
        return ["has no explicit 'if', so an implicit success() lets any skipped ancestor skip it"]
    text = " ".join(condition.split())
    if not re.search(r"(!\s*cancelled\(\)|always\(\))", text):
        problems.append("its 'if' has no status function (!cancelled() or always()), so the implicit success() still applies")
    for need in needs:
        pattern = r"needs\." + re.escape(need) + r"\.result\s*==\s*'success'"
        if not re.search(pattern, text):
            problems.append("its 'if' does not require needs." + need + ".result == 'success'")
    return problems


def selftest_deploy_gate():
    """Prove deploy_gate_problems can refuse and can pass. Returns problem count."""
    needs = ["target", "check-pending-migrations", "check-types-drift"]
    full = ("${{ !cancelled() && needs.target.result == 'success'"
            " && needs.check-pending-migrations.result == 'success'"
            " && needs.check-types-drift.result == 'success' }}")
    refused = {
        "no if at all (the 2026-11-12 prod defect)": None,
        "an if with no status function": full.replace("!cancelled() && ", ""),
        "an if that drops one gate": full.replace(" && needs.check-types-drift.result == 'success'", ""),
        "a gate loosened to not-failed, which lets a skipped gate through": full.replace(
            "needs.check-types-drift.result == 'success'", "needs.check-types-drift.result != 'failure'"),
        "an empty if": "",
    }
    bad = 0
    for label, condition in refused.items():
        if not deploy_gate_problems(needs, condition):
            print("::error::self-test failed: " + label + " was accepted")
            bad += 1
    if deploy_gate_problems(needs, full):
        print("::error::self-test failed: a correct gate was refused")
        bad += 1
    if not bad:
        print("deploy gate check refused " + str(len(refused)) + " unsafe shapes and accepted 1 good one")
    return bad


def check_deploy_gate():
    """Check the real deploy job. Returns the number of problems."""
    path = os.path.join(WORKFLOW_DIR, DEPLOY_GATE_FILE)
    if not os.path.isfile(path):
        annotate(path, "is missing, so the deploy gate could not be checked")
        return 1
    with open(path, "r", encoding="utf-8") as handle:
        try:
            document = yaml.safe_load(handle.read())
        except yaml.YAMLError:
            return 0  # check_file already reports a parse failure
    job = ((document or {}).get("jobs") or {}).get(DEPLOY_GATE_JOB)
    if not isinstance(job, dict):
        annotate(path, "has no job '" + DEPLOY_GATE_JOB + "', so its gate could not be checked")
        return 1
    needs = job.get("needs") or []
    if isinstance(needs, str):
        needs = [needs]
    found = deploy_gate_problems(needs, job.get("if"))
    for reason in found:
        annotate(path, "job '" + DEPLOY_GATE_JOB + "' " + reason)
    return len(found)


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

    problems = selftest_deploy_gate()
    for name in names:
        problems += check_file(os.path.join(WORKFLOW_DIR, name))
    problems += check_deploy_gate()

    print("checked " + str(len(names)) + " workflow file(s) under "
          + WORKFLOW_DIR + ": " + str(problems) + " problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
