# Red demo for the pull-request commit-metadata scan

This file exists only so that a commit can exist. It is never merged, and the
pull request that carries it is closed as soon as the check has been observed
failing.

The point of the demo is the commit MESSAGE, not this file. The message on the
commit that adds this file carries a synthetic home-directory path, which is
one of the classes the scan refuses. The tree here is deliberately boring, so
the only thing that can turn the check red is the metadata.

The companion pull request contains the same workflow change with no such
commit, and it passes. Two trees that differ by one commit message, one red and
one green.
